/**
 * 观察期 / 血缘 演示
 *
 * 场景就是你那次事故的真实来路：
 *   smoke 的评测集 = 从全量评测集里随机抽 100 条
 *
 * 关键点：这个信息**不在契约里，也不在 manifest 里**，只在当时的命令里。
 * 演示的目标是证明——即使 manifest 完全没标用途（purpose 为空），
 * 光靠观察期记下来的命令，gate 也能判出"这是抽样产物，不是全量"。
 *
 *   node test/ledger-demo.ts
 */

import { precheck, inferLineage, isSampled, lineageRoots, parseCmdLineage, opOf } from "../contract-gate.ts";
import type { LedgerEvent, Contract } from "../contract-gate.ts";

const cmds = [
  // 上次做 smoke 时的真实命令
  "python sample.py --src data/full/eval.jsonl --n 100 --out data/smoke/eval.jsonl",
  "head -n 1024 data/full/train.jsonl > data/smoke/train.jsonl",
  "cat config/train.yaml",
];

const events: LedgerEvent[] = cmds.map((cmd, i) => ({
  ts: `2026-11-24T09:0${i}:00Z`,
  kind: "tool_call" as const,
  tool: "bash",
  cmd,
  ...parseCmdLineage(cmd),
}));

const lineage = inferLineage(events);

console.log("\n=== 账本里记到的命令 ===");
for (const e of events) console.log(`  [${opOf(e.cmd!)}] ${e.cmd}`);

console.log("\n=== 推出的血缘图 ===");
for (const [out, e] of Object.entries(lineage)) {
  console.log(`  ${out}`);
  console.log(`    ← ${e.from.join(", ") || "(无)"}   [${e.ops.join(", ")}]`);
}

console.log("\n=== 查询 ===");
for (const p of ["data/smoke/eval.jsonl", "data/smoke/train.jsonl", "data/full/eval.jsonl"]) {
  console.log(
    `  ${p.padEnd(26)} sampled=${String(isSampled(p, lineage)).padEnd(5)} roots=${lineageRoots(p, lineage).join(", ")}`,
  );
}

// 关键演示：contract 里 purpose 留空 —— 模拟"manifest 还没填"
const c: Contract = {
  id: "demo",
  createdAt: "2026-11-25T00:00:00Z",
  instruction: "训练集准备好了，开始全量训推吧",
  intent: "用全量数据做一次完整训推",
  plan: "跑 run_train.sh",
  inputs: [
    { role: "train", label: "训练集", resolved: { path: "data/smoke/train.jsonl", lines: 1024, bytes: 1048576 } },
    { role: "eval", label: "测试集", resolved: { path: "data/smoke/eval.jsonl", lines: 100, bytes: 262144 } },
  ],
  outputs: [],
  diffFromLastRun: "无变化",
  skillDeviations: "无",
  state: "draft",
};

console.log("\n=== 两种判定对比 ===");
const without = precheck(c);
const withL = precheck(c, lineage);
console.log(`  不给血缘: ${without.length ? "打回" : "放行  ← 只看 manifest 会漏"}`);
without.forEach((v) => console.log(`      ${v.reason}`));
console.log(`  给血缘  : ${withL.length ? "打回" : "放行"}`);
withL.forEach((v) => console.log(`      ${v.reason}`));
console.log();
