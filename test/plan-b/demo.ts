/**
 * B（dry-run 自报）的可运行演示 —— 也是给二次开发看的施工图
 *
 * 一次跑两遍：同一个指令「开始全量训推」，分别配上 smoke 配置和 full 配置。
 * 你会看到：不接 B 时两次都放行；接上 B 后 smoke 被打回。
 *
 *   node test/plan-b/demo.ts
 *
 * 注意：这个 demo 里的 checkB() 就是**你要在 contract-gate.ts 里加的那几条规则**。
 * 大约 30 行，没有魔法。
 */

import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { precheck, type Contract } from "../../contract-gate.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const DRYRUN = join(HERE, "dryrun.py");

const INSTRUCTION = "训练集准备好了，开始全量训推吧";
const FULLISH = /(全量|完整|full|正式|最终)/i;

type Resolved = {
  schema: string;
  project?: string;
  stage?: string;
  scope: string;
  inputs: {
    role: string;
    path: string;
    purpose?: string;
    lines?: number | null;
    bytes?: number | null;
    derived_from?: string[];
    derivation?: string;
  }[];
  params?: Record<string, number | string>;
  outputs?: { role: string; path: string }[];
};

/* ───── 这就是 B 的规则，全部 ───── */
function checkB(c: Contract, r: Resolved): string[] {
  const out: string[] = [];
  const wantsFull = FULLISH.test(c.instruction);

  // 规则 1：脚本自己承认的规模，和指令要求的规模对不上
  if (wantsFull && r.scope !== "full") {
    out.push(`规模不匹配：脚本自报 scope=${r.scope}，但指令要求「全量」。`);
  }
  // 规则 2：要全量，但某一路数据是派生（抽样/切分）出来的
  for (const i of r.inputs) {
    if (wantsFull && i.derived_from?.length) {
      out.push(
        `数据来源不匹配：${i.path} 派生自 ${i.derived_from.join(", ")}（${i.derivation || "来源未注明"}）。全量任务应用上游。`,
      );
    }
  }
  // 规则 3：脚本声明的缺失文件
  for (const i of r.inputs) {
    if (i.bytes === null) out.push(`数据缺失：${i.path} 不存在（脚本自报）。`);
  }
  return out;
}

function runDryRun(cfg: string): Resolved {
  const txt = execFileSync("python", [DRYRUN, "--config", join(HERE, cfg), "--root", HERE], {
    encoding: "utf8",
  });
  return JSON.parse(txt);
}

/** 把脚本自报的事实，覆盖到模型写的契约上。 */
function merge(c: Contract, r: Resolved): Contract {
  const byRole = new Map(r.inputs.map((i) => [i.role, i]));
  return {
    ...c,
    inputs: c.inputs.map((inp) => {
      const hit = byRole.get(inp.role);
      if (!hit) return inp;
      return {
        ...inp,
        resolved: {
          path: hit.path,
          lines: hit.lines ?? undefined,
          bytes: hit.bytes ?? undefined,
          purpose: hit.purpose,
        },
      };
    }),
  };
}

function fmt(c: Contract): string {
  return c.inputs
    .map((i) => {
      const v = i.resolved;
      return `    [${i.role}] ${i.label} → ${v.path} | ${
        v.lines !== undefined ? `${v.lines} 行` : "?"
      } · purpose=${v.purpose ?? "(空)"}`;
    })
    .join("\n");
}

function main() {
  // 数据集是生成出来的（缩小版），第一次跑自动补上
  try {
    execFileSync("python", ["-c", "open(r'" + join(HERE, "data/full/train.jsonl").replace(/\\/g, "/") + "')"], {
      stdio: "ignore",
    });
  } catch {
    execFileSync("python", [join(HERE, "gen_fixtures.py")], { stdio: "inherit" });
  }

  // 模型写的契约：路径是对的，但它不知道"该不该用这个"
  const modelContract: Contract = {
    id: "2026-11-25-qwen35-full",
    createdAt: "2026-11-25T09:30:00Z",
    instruction: INSTRUCTION,
    intent: "用全量训练集做一次完整训推",
    plan: "沿用训练 skill 跑 run_train.sh 与 run_eval.sh",
    inputs: [
      { role: "train", label: "训练集", resolved: { path: "data/smoke/train.jsonl", bytes: 1024 } },
      { role: "eval", label: "测试集", resolved: { path: "data/smoke/eval.jsonl", bytes: 1024 } },
    ],
    outputs: [],
    diffFromLastRun: "无变化（沿用 smoke 配置）",
    skillDeviations: "无",
    state: "draft",
  };

  console.log("\n指令：" + INSTRUCTION + "\n");

  console.log("─── 0. 不接 B：只看模型写的契约 ───");
  console.log(fmt(modelContract));
  const base = precheck(modelContract);
  console.log(`  → precheck: ${base.length ? "打回" : "放行"}`);
  console.log("     （路径、行数都没问题 —— 这就是那天能一路跑到汇报的原因）\n");

  for (const cfg of ["config.smoke.json", "config.full.json"]) {
    const r = runDryRun(cfg);
    console.log(`─── ${cfg} ───`);
    console.log(`  脚本自报: scope=${r.scope}  params=${JSON.stringify(r.params)}`);
    const merged = merge(modelContract, r);
    console.log("  合并后的契约:");
    console.log(fmt(merged));

    const pre = precheck(merged);
    const b = checkB(merged, r);
    const all = [...pre.map((v) => v.reason), ...b];
    console.log(`  → precheck: ${pre.length ? "打回" : "放行"}`);
    console.log(`  → B 规则  : ${b.length ? "打回" : "放行"}`);
    if (all.length) all.forEach((x) => console.log(`      · ${x}`));
    console.log();
  }

  console.log("结论：同一份模型契约，配上 smoke 配置 —— 不接 B 放行，接上 B 打回。");
  console.log("     B 补的不是「数据表」，是「这张表该和哪个数字对得上」。\n");
}

main();
