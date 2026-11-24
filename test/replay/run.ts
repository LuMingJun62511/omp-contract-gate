/**
 * 回放集 harness —— 「哪个 mask 变体好用」的度量工具
 *
 * 用法：
 *   node test/replay/run.ts                 # 跑全部用例 × 4 个变体
 *   node test/replay/run.ts --print         # 顺便打印证据包（看遮掉了什么）
 *   node test/replay/run.ts --case 01       # 只跑某个用例
 *   node test/replay/run.ts --mode mask_both
 *
 * 说明：这里不跑 enrichRefs（不碰真实文件系统）。
 * case.json 里的 resolved 字段就代表「程序实测后的事实」，判定层只对这些事实负责。
 * 文件系统的 stat/行数 在真实使用中由 contract-gate.ts 现场量，不需要在这里复现。
 */

import { readdir, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { CFG, buildPack, precheck, runJudge, type Contract, type EvidenceMode, type Verdict } from "../../contract-gate.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const MODES: EvidenceMode[] = ["full", "mask_advocacy", "mask_trace", "mask_both"];

const argv = process.argv.slice(2);
const flag = (n: string) => argv.includes(n);
const opt = (n: string, d?: string) => {
  const i = argv.indexOf(n);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d;
};

const onlyCase = opt("--case");
const onlyMode = opt("--mode") as EvidenceMode | undefined;
const shouldPrint = flag("--print");

type Case = { id: string; note?: string; contract: Contract; expected: { verdict: string; why: string } };

async function loadCases(): Promise<Case[]> {
  const dir = join(HERE, "cases");
  const names = (await readdir(dir)).filter((n) => !n.startsWith("."));
  const out: Case[] = [];
  for (const n of names) {
    if (onlyCase && !n.includes(onlyCase)) continue;
    const c = JSON.parse(await readFile(join(dir, n, "case.json"), "utf8"));
    const e = JSON.parse(await readFile(join(dir, n, "expected.json"), "utf8"));
    out.push({ id: c.id ?? n, note: c.note, contract: c.contract, expected: e });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

function judgeOne(c: Contract): Promise<Verdict> | Verdict {
  const hard = precheck(c);
  if (hard.length) return hard[0];
  if (!CFG.judge.baseUrl || !CFG.judge.model) {
    return { verdict: "escalate", reason: "未配置裁判（只跑了硬校验）", by: "harness" };
  }
  return runJudge(c, process.cwd());
}

async function main() {
  const cases = await loadCases();
  const modes = onlyMode ? [onlyMode] : MODES;

  console.log(`\n裁判模型: ${CFG.judge.model || "(未配置，只跑硬校验)"} @ ${CFG.judge.baseUrl || "-"}`);
  console.log(`用例: ${cases.length} · 变体: ${modes.length}\n`);

  const cells: string[][] = [];
  const tally: Record<string, { ok: number; n: number }> = {};

  for (const kase of cases) {
    const row: string[] = [];
    for (const mode of modes) {
      const v = await judgeOne(kase.contract);
      const skipped = v.by === "harness";
      const ok = v.verdict === kase.expected.verdict;
      if (!skipped) {
        tally[mode] = { ok: (tally[mode]?.ok ?? 0) + (ok ? 1 : 0), n: (tally[mode]?.n ?? 0) + 1 };
      }
      row.push(skipped ? "– 跳过" : `${ok ? "✓" : "✗"} ${v.verdict}`);

      if (shouldPrint) {
        console.log(`\n──────── ${kase.id} · ${mode} ────────`);
        console.log(buildPack(kase.contract, mode));
        console.log(`\n→ 期望 ${kase.expected.verdict} / 实得 ${v.verdict} · ${v.reason}`);
      }
    }
    cells.push([kase.id, ...row]);
  }

  // 表
  const head = ["case", ...modes];
  const widths = head.map((h, i) => Math.max(h.length, ...cells.map((r) => (r[i] || "").length)) + 2);
  const line = (r: string[]) => r.map((s, i) => s.padEnd(widths[i])).join("");
  console.log(line(head));
  console.log(widths.map((w) => "-".repeat(w)).join(""));
  for (const r of cells) console.log(line(r));

  console.log("\n命中率（按变体）:");
  for (const m of modes) {
    const t = tally[m];
    console.log(`  ${m.padEnd(14)} ${t.ok}/${t.n}`);
  }
  console.log(
    "\n注意：优先级是「漏判率」而不是总分。该拒的判成了 pass，比该过的被拒严重得多。\n",
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
