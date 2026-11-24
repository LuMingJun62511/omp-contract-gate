/**
 * omp-contract-gate v0.1
 * ==========================================================================
 * 执行前的可驳回契约（plan gate）。四件事：
 *
 *   1. 取证  —— 只读命令放行；高危工具在「契约通过」前一律 block
 *   2. 硬校验 —— 纯代码检查（路径存在 / 行数 / 用途 smoke vs full / 指代词未落实）
 *   3. 判定  —— 独立模型对照【用户指令原文 + 契约 + 程序实测事实】做 rubric 核验
 *   4. 留痕  —— 契约落盘，成为可复盘的轨迹（第二阶段的训练材料）
 *
 * 设计原则：
 *   - 判据来自**程序输出**，不来自模型自述（resolved 值由本文件实测覆盖）
 *   - 裁判是**另一个模型**，且只看证据、不看模型的辩护（可选变体）
 *   - 每个契约最多自动判定 2 次，之后强制升级人工（防死循环）
 *   - 有 kill switch（CG_DISABLE=1），闸出 bug 时不至于把agent锁死
 *
 * ---------------------------------------------------------------------------
 * 安装（公司里）：
 *   cp contract-gate.ts  <项目>/.omp/hooks/pre/contract-gate.ts
 *   # 或者不安装，直接跑：omp --hook <绝对路径>/contract-gate.ts
 *
 * 必配的环境变量（裁判是独立端点）：
 *   CG_JUDGE_BASE_URL=https://.../v1
 *   CG_JUDGE_API_KEY=sk-...
 *   CG_JUDGE_MODEL=<和规划模型不同族的模型>
 *
 * 可选：
 *   CG_MODE=full|mask_advocacy|mask_trace|mask_both   # 证据变体，默认 mask_advocacy
 *   CG_TOOLS=bash,write,edit                           # 受闸工具
 *   CG_DISABLE=1                                       # 关掉闸
 *   CG_ON_NO_JUDGE=escalate|allow                      # 没配裁判时怎么办，默认 escalate
 * ==========================================================================
 */

import { readFile, writeFile, appendFile, mkdir, stat } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

/* ─────────────────────────── 0. 配置 ─────────────────────────── */

export type EvidenceMode = "full" | "mask_advocacy" | "mask_trace" | "mask_both";

export const CFG = {
  mode: (process.env.CG_MODE as EvidenceMode) || "mask_advocacy",
  disabled: process.env.CG_DISABLE === "1",
  gated: (process.env.CG_TOOLS || "bash,write,edit").split(",").map((s) => s.trim()).filter(Boolean),
  contractPath: process.env.CG_CONTRACT || ".agent/contracts/current.json",
  manifestPath: process.env.CG_MANIFEST || ".agent/manifest.json",
  onNoJudge: process.env.CG_ON_NO_JUDGE || "escalate",
  maxJudgeAttempts: Number(process.env.CG_MAX_ATTEMPTS || 2),
  /** 观察期：从第一轮起就把工具调用记进账本（只记录，不判断，失败静默） */
  observe: process.env.CG_OBSERVE !== "0",
  ledgerPath: process.env.CG_LEDGER || ".agent/ledger/events.jsonl",
  judge: {
    baseUrl: process.env.CG_JUDGE_BASE_URL || "",
    apiKey: process.env.CG_JUDGE_API_KEY || "",
    model: process.env.CG_JUDGE_MODEL || "",
    timeoutMs: Number(process.env.CG_JUDGE_TIMEOUT_MS || 90_000),
  },
};

/**
 * 证据变体 = 2×2：要不要「过程」、要不要「辩护」。
 * 加变体只改这张表；切换只用 CG_MODE，不动代码。
 * 第一列（指令 / skill / 契约 / 文件事实）永远保留 —— 那是判据本身。
 */
const KEEP: Record<EvidenceMode, { trace: boolean; rationale: boolean }> = {
  full:          { trace: true,  rationale: true  },
  mask_advocacy: { trace: true,  rationale: false },
  mask_trace:    { trace: false, rationale: true  },
  mask_both:     { trace: false, rationale: false },
};

/* ─────────────── 0.5 观察期：从第一轮就在看 ─────────────── */

/**
 * gate 不只是执行前的关卡，它从会话第一轮起就在记。
 *
 * 为什么必须这样：「smoke 的评测集是从全量评测集里随机抽 100 条来的」这种
 * 血缘信息，从来不写在契约里，也不写在 manifest 里——它只存在于**当时的命令**里。
 * 等真跑全量时再问模型「这个数据哪来的」，得到的是模型的回忆（=幻觉风险），
 * 不是事实。
 *
 * 所以：命令一出现就记，判断留给后面。**采集面决定上限，mask 只决定给不给。**
 */

export type LedgerEvent = {
  ts: string;
  kind: "tool_call" | "tool_result";
  tool: string;
  cmd?: string;
  ins?: string[];
  outs?: string[];
  ok?: boolean;
};

export type Lineage = Record<string, { from: string[]; ops: string[]; ts?: string }>;

const PATHLIKE = /[\w.\\/-]+\.(?:jsonl|json|ndjson|csv|tsv|parquet|txt|yaml|yml|py|sh|md|pth|safetensors|bin)\b/g;

/** 从 bash 命令里抽出「读了谁、写了谁」。纯字符串解析，不调模型。 */
export function parseCmdLineage(cmd: string): { ins: string[]; outs: string[] } {
  const outs = new Set<string>();
  for (const m of cmd.matchAll(/(?:>>?)\s*([^\s|;&<>)]+)/g)) outs.add(stripQuote(m[1]));
  for (const m of cmd.matchAll(/\s(?:-o|--out|--output|--save|--dst)\s+([^\s|;&<>)]+)/g)) outs.add(stripQuote(m[1]));

  const head = stripQuote(String(cmd.trim().split(/\s+/)[0] || ""));
  const all = [...cmd.matchAll(PATHLIKE)].map((m) => m[0]);
  const ins = [
    ...new Set(
      all.filter(
        (p) => p !== head && !outs.has(p) && !/\.(py|sh|js|ts|mjs|cjs)$/i.test(p),
      ),
    ),
  ];
  return { ins, outs: [...outs] };
}

function stripQuote(s: string): string {
  return s.replace(/^["']|["']$/g, "");
}

/** 命令里蕴含的算子。sample/split/shuffle 是最关键的三类——它们是"全量被缩水"的证据。 */
export function opOf(cmd: string): string {
  if (/\b(head|tail)\b\s+(-n\s*)?\d+/.test(cmd)) return "sample";
  if (/\bshuf\b/.test(cmd)) return "shuffle";
  if (/\bsplit\b/.test(cmd)) return "split";
  if (/\bsample\b|--n[_-]?samples?\b|\s--n\s+\d+|train_test_split/i.test(cmd)) return "sample";
  if (/\bgrep\b|\bawk\b|\bjq\b/.test(cmd)) return "filter";
  if (/>/.test(cmd)) return "derive";
  return "read";
}

export function observeTool(tool: string, input: any): LedgerEvent {
  const base: LedgerEvent = { ts: new Date().toISOString(), kind: "tool_call", tool };
  if (tool === "bash") {
    const cmd = String(input?.command ?? "");
    return { ...base, cmd, ...parseCmdLineage(cmd) };
  }
  const p = String(input?.file_path ?? input?.filePath ?? input?.path ?? input?.file ?? "");
  if (!p) return base;
  if (tool === "write" || tool === "edit" || tool === "multiedit") return { ...base, outs: [p] };
  return { ...base, ins: [p] };
}

async function appendLedger(cwd: string, ev: LedgerEvent): Promise<void> {
  try {
    const abs = resolve(cwd, CFG.ledgerPath);
    await mkdir(dirname(abs), { recursive: true });
    await appendFile(abs, JSON.stringify(ev) + "\n", "utf8");
  } catch {
    /* 观察器永远不能影响主流程 */
  }
}

export async function loadLedger(cwd: string): Promise<LedgerEvent[]> {
  try {
    const txt = await readFile(resolve(cwd, CFG.ledgerPath), "utf8");
    return txt.split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

/** 从账本推出血缘图：out ← [ins]，并标注算子。 */
export function inferLineage(events: LedgerEvent[]): Lineage {
  const g: Lineage = {};
  for (const e of events) {
    if (e.kind !== "tool_call" || !e.outs?.length) continue;
    const op = opOf(e.cmd || "");
    for (const o of e.outs) {
      const cur = g[o] ?? { from: [], ops: [] };
      cur.from = [...new Set([...cur.from, ...(e.ins ?? [])])];
      cur.ops = [...new Set([...cur.ops, op])];
      cur.ts = e.ts;
      g[o] = cur;
    }
  }
  return g;
}

/** 一路往上找，直到没有来源为止。 */
export function lineageRoots(p: string, g: Lineage, seen = new Set<string>()): string[] {
  if (seen.has(p)) return [];
  seen.add(p);
  const e = g[p];
  if (!e || !e.from.length) return [p];
  return e.from.flatMap((f) => lineageRoots(f, g, seen));
}

/** 这条路径（或它的任一祖先）是不是被抽样/切分出来的。 */
export function isSampled(p: string, g: Lineage, depth = 0): boolean {
  if (depth > 12) return false;
  const e = g[p];
  if (!e) return false;
  if (e.ops.some((o) => o === "sample" || o === "shuffle" || o === "split")) return true;
  return e.from.some((f) => isSampled(f, g, depth + 1));
}

/* ─────────────────────────── 1. 契约模型 ─────────────────────────── */

export type Ref = {
  role: string;
  /** 人写的模糊说法，如「全量训练集」 */
  label: string;
  /** 解析后的实体。lines/mtime/purpose 会被实测值覆盖 */
  resolved: {
    path: string;
    lines?: number;
    bytes?: number;
    mtime?: string;
    purpose?: string;
  };
};

export type Verdict = {
  verdict: "pass" | "reject" | "escalate";
  reason: string;
  uncovered?: string[];
  contradicted?: string[];
  checked?: string[];
  /** 由硬校验产生时为 "precheck" */
  by?: string;
};

export type Contract = {
  id: string;
  createdAt: string;
  /** 用户指令逐字原文 —— 不许可改写 */
  instruction: string;
  skillText?: string;
  /** 第一句：模糊命令被拆成了什么意图 */
  intent: string;
  /** 第二句：打算怎么做 */
  plan: string;
  inputs: Ref[];
  outputs: Ref[];
  /** 本次与上一次运行的差异 */
  diffFromLastRun: string;
  /** 指令与 skill 默认路径的偏离 */
  skillDeviations: string;
  /** 规划者自述（辩护）—— 多数变体会遮掉 */
  rationale?: string;
  /** 工具调用轨迹（过程）—— 部分变体会遮掉 */
  trace?: { tool: string; call: string; filesRead: string[] }[];
  state: "draft" | "approved" | "rejected" | "escalated";
  judge?: Verdict;
  judgeAttempts?: number;
  result?: string;
  /** 人的批注 —— 第二阶段唯一真正的产出 */
  humanNote?: string;
};

/* ─────────────────────── 2. 事实：程序实测 ─────────────────────── */

type Manifest = {
  datasets?: { path: string; purpose?: string; expected_lines?: number; note?: string }[];
  aliases?: Record<string, string>;
};

async function loadManifest(cwd: string): Promise<Manifest> {
  try {
    return JSON.parse(await readFile(resolve(cwd, CFG.manifestPath), "utf8"));
  } catch {
    return {};
  }
}

async function countLines(p: string, bytes: number): Promise<number | undefined> {
  if (bytes > 32 * 1024 * 1024) return undefined; // 太大就别读了
  try {
    const t = await readFile(p, "utf8");
    let n = 0;
    for (let i = 0; i < t.length; i++) if (t.charCodeAt(i) === 10) n++;
    return t.length && t.charCodeAt(t.length - 1) !== 10 ? n + 1 : n;
  } catch {
    return undefined;
  }
}

/**
 * 把契约里的每个引用，替换成磁盘上的真实值。
 * 这是「不信任模型自述」的落点：模型说 512000 行，这里量出来多少就是多少。
 */
export async function enrichRefs(refs: Ref[], cwd: string, manifest: Manifest): Promise<Ref[]> {
  const out: Ref[] = [];
  for (const r of refs ?? []) {
    const raw = r.resolved?.path || manifest.aliases?.[r.label] || "";
    const next: Ref = { ...r, resolved: { ...r.resolved, path: raw } };
    if (!raw) { out.push(next); continue; }

    const abs = resolve(cwd, raw);
    try {
      const st = await stat(abs);
      next.resolved.bytes = st.size;
      next.resolved.mtime = st.mtime.toISOString();
      if (st.isFile()) next.resolved.lines = await countLines(abs, st.size);
    } catch {
      next.resolved.bytes = undefined; // 不存在
    }

    const hit = manifest.datasets?.find((d) => resolve(cwd, d.path) === abs);
    if (hit?.purpose) next.resolved.purpose = hit.purpose;
    out.push(next);
  }
  return out;
}

/* ──────────────────── 3. 硬校验：不花模型一分钱 ──────────────────── */

const PRONOUN = /(训练集|测试集|评测集|验证集|数据集|提示词|权重|模型文件)/;
const FULLISH = /(全量|完整|full|正式|最终)/i;

/**
 * 纯确定性检查。这一层准确率 100%，且必须在调模型之前跑。
 * 它单独就能拦住「smoke 当全量」这个具体事故。
 */
export function precheck(c: Contract, lineage?: Lineage): Verdict[] {
  const bad: Verdict[] = [];
  const add = (reason: string, contradicted?: string[]) =>
    bad.push({ verdict: "reject", reason, contradicted, by: "precheck" });

  for (const r of [...(c.inputs ?? []), ...(c.outputs ?? [])]) {
    const p = r.resolved?.path || "";
    if (!p) {
      if (PRONOUN.test(r.label || "")) {
        add(`指代词未实体化：「${r.label}」没有落到具体路径。模糊说法一律不进入执行。`);
      }
      continue;
    }
    if (r.resolved.bytes === undefined) {
      add(`路径不存在或不可读：${p}`);
      continue;
    }
    // smoke 数据被用于「全量」类指令
    if (r.resolved.purpose === "smoke" && FULLISH.test(c.instruction || "")) {
      add(
        `用途不匹配：用户指令是「${c.instruction}」，但 ${r.label} 指向 ${p}（purpose=smoke）。`,
        [`${r.label} → ${p} · purpose=smoke`],
      );
    }
    // 血缘：即使 manifest 没标用途，也能看出这是抽样产物
    if (lineage && FULLISH.test(c.instruction || "") && isSampled(p, lineage)) {
      add(
        `血缘不匹配：${p} 是抽样/切分产物（血缘根：${lineageRoots(p, lineage).join(", ")}）。全量任务应使用上游数据集。`,
        [`${r.label} → ${p} · 血缘链含 sample/shuffle/split`],
      );
    }
    // 行数与 manifest 声明不符（说明文件被替换过）
    const declared = (c as any).__manifestLines?.[p];
    if (declared && r.resolved.lines && declared !== r.resolved.lines) {
      add(`行数与预期不符：${p} 实测 ${r.resolved.lines} 行，manifest 声明 ${declared} 行。`);
    }
  }

  if (!c.intent?.trim() || !c.plan?.trim()) add("契约缺少意图或计划（两句必须都写）。");
  if (!c.diffFromLastRun?.trim()) add("契约缺少「与上次运行的差异」。空着就等于声称完全一样，必须写明。");
  return bad;
}

/* ────────────────────── 4. 证据包 + 裁判 ────────────────────── */

export function buildPack(c: Contract, mode: EvidenceMode = CFG.mode): string {
  const keep = KEEP[mode];
  const L: string[] = [];

  L.push("=== 1. 用户指令（逐字原文，不得改写）===");
  L.push(c.instruction || "(空)");

  if (c.skillText) {
    L.push("", "=== 2. 命中的 skill 原文 ===");
    L.push(c.skillText);
  }

  L.push("", "=== 3. 待审契约 ===");
  L.push(`意图：${c.intent}`);
  L.push(`计划：${c.plan}`);
  L.push("输入：");
  L.push(fmtRefs(c.inputs));
  L.push("输出：");
  L.push(fmtRefs(c.outputs));
  L.push(`与上次运行的差异：${c.diffFromLastRun || "(空)"}`);
  L.push(`与 skill 默认路径的偏离：${c.skillDeviations || "(空)"}`);

  if (keep.trace && c.trace?.length) {
    L.push("", "=== 4. 工具调用轨迹（过程，程序记录）===");
    for (const t of c.trace) {
      L.push(`- ${t.tool}: ${t.call}${t.filesRead?.length ? `  «读 ${t.filesRead.join(", ")}»` : ""}`);
    }
  }

  if (keep.rationale && c.rationale) {
    L.push("", "=== 5. 规划者自述（注意：这是被审查方的辩解，不是事实）===");
    L.push(c.rationale);
  }

  L.push("", `（证据变体：${mode} · 轨迹${keep.trace ? "已含" : "已遮"} · 自述${keep.rationale ? "已含" : "已遮"}）`);
  return L.join("\n");
}

function fmtRefs(refs: Ref[] = []): string {
  if (!refs.length) return "  (无)";
  return refs
    .map((r) => {
      const v = r.resolved || ({} as Ref["resolved"]);
      const bits = [
        v.lines !== undefined ? `${v.lines} 行` : null,
        v.bytes !== undefined ? `${v.bytes} B` : null,
        v.mtime ? `mtime ${v.mtime}` : null,
        v.purpose ? `purpose=${v.purpose}` : null,
        v.bytes === undefined ? "!! 路径不存在" : null,
      ].filter(Boolean);
      return `  - [${r.role}] ${r.label} → ${v.path || "(未落实)"} | ${bits.join(" · ")}`;
    })
    .join("\n");
}

export const RUBRIC = `你是独立复核员。你不制定方案、不修改方案，只判定方案是否与用户指令一致。

步骤：
1. 把【用户指令】拆成若干条可以判真假的独立断言。
2. 逐条在【待审契约】中找对应项。
3. 特别检查三类高频错误：
   a) 用户要求的范围/规模（例如"全量"）在契约里是否被悄悄降级（例如用了 smoke/抽样数据）；
   b) 契约里是否存在"指代但未落实"的说法（例如只写"训练集"而没有具体路径）；
   c) 契约声明的数据用途，与它所指向的文件的实际用途是否矛盾。
4. 若证据不足以判断（例如缺少文件事实），不要猜，判 escalate。

只输出 JSON，不要任何其他文字：
{
  "verdict": "pass" | "reject" | "escalate",
  "reason": "一句话说清结论",
  "uncovered": ["未被契约覆盖的断言"],
  "contradicted": ["与断言矛盾的契约项，必须带具体路径/数值"],
  "checked": ["即使判 pass，也必须列出你实际核对过的三项"]
}`;

export async function runJudge(c: Contract, cwd: string): Promise<Verdict> {
  const { baseUrl, apiKey, model, timeoutMs } = CFG.judge;
  if (!baseUrl || !model) {
    return CFG.onNoJudge === "allow"
      ? { verdict: "pass", reason: "未配置裁判，按 CG_ON_NO_JUDGE=allow 放行", by: "fallback" }
      : { verdict: "escalate", reason: "未配置裁判模型（CG_JUDGE_BASE_URL / CG_JUDGE_MODEL）", by: "fallback" };
  }

  const pack = buildPack(c);
  const body = {
    model,
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: RUBRIC },
      { role: "user", content: pack },
    ],
  };

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
    if (!res.ok) {
      return { verdict: "escalate", reason: `裁判端点返回 ${res.status}`, by: "judge" };
    }
    const json: any = await res.json();
    const text = json?.choices?.[0]?.message?.content ?? "";
    return parseVerdict(text);
  } catch (e: any) {
    return { verdict: "escalate", reason: `裁判调用失败：${e?.message || e}`, by: "judge" };
  } finally {
    clearTimeout(timer);
  }
}

export function parseVerdict(text: string): Verdict {
  try {
    const s = text.indexOf("{");
    const e = text.lastIndexOf("}");
    const o = JSON.parse(s >= 0 && e > s ? text.slice(s, e + 1) : text);
    const v = o.verdict === "pass" || o.verdict === "reject" ? o.verdict : "escalate";
    return {
      verdict: v,
      reason: String(o.reason || ""),
      uncovered: o.uncovered,
      contradicted: o.contradicted,
      checked: o.checked,
      by: "judge",
    };
  } catch {
    return { verdict: "escalate", reason: "裁判输出无法解析（不放行）", by: "judge" };
  }
}

/* ────────────────────────── 5. 存取 ────────────────────────── */

function contractAbs(cwd: string) {
  return resolve(cwd, CFG.contractPath);
}

export async function loadContract(cwd: string): Promise<Contract | null> {
  try {
    return JSON.parse(await readFile(contractAbs(cwd), "utf8"));
  } catch {
    return null;
  }
}

async function saveContract(cwd: string, c: Contract) {
  const abs = contractAbs(cwd);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, JSON.stringify(c, null, 2), "utf8");
}

/* ─────────────────────── 6. 取证豁免 ─────────────────────── */

const READONLY_PREFIX = [
  "ls", "dir", "cat", "type", "head", "tail", "wc", "stat", "file", "find", "grep", "rg",
  "sha256sum", "md5sum", "du", "df", "pwd", "date", "env", "which", "nvidia-smi",
  "git status", "git log", "git diff", "git show", "git branch",
  "python -c", "python3 -c", "node -e", "sed -n", "awk",
];

function targetPath(input: any): string {
  return String(input?.file_path ?? input?.filePath ?? input?.path ?? input?.file ?? "");
}

/** 取证动作永远放行 —— 否则「先取证再登记契约」就死锁了。 */
export function isEvidenceGathering(tool: string, input: any): boolean {
  if (tool === "read" || tool === "grep" || tool === "glob" || tool === "ls" || tool === "websearch") return true;
  if (tool === "write" || tool === "edit" || tool === "multiedit") {
    const p = targetPath(input).replace(/\\/g, "/");
    return p.includes(".agent/contracts/") || p.includes(CFG.contractPath.replace(/\\/g, "/"));
  }
  if (tool === "bash") {
    const cmd = String(input?.command ?? "").trim();
    if (!cmd) return true;
    return READONLY_PREFIX.some((p) => cmd === p || cmd.startsWith(p + " ") || cmd.startsWith(p + "\t"));
  }
  return false;
}

/* ─────────────────────────── 7. 闸 ─────────────────────────── */

function block(reason: string, extra?: string) {
  return { block: true, reason, ...(extra ? { additionalContext: extra } : {}) };
}

function verdictText(v: Verdict): string {
  const lines = [`【${v.by || "judge"}】${v.verdict}: ${v.reason}`];
  if (v.uncovered?.length) lines.push(`未覆盖: ${v.uncovered.join(" | ")}`);
  if (v.contradicted?.length) lines.push(`矛盾: ${v.contradicted.join(" | ")}`);
  if (v.checked?.length) lines.push(`已核对: ${v.checked.join(" | ")}`);
  return lines.join("\n");
}

export function contractGate(pi: ExtensionAPI) {
  pi.on("tool_call", async (event: any, ctx: any) => {
    if (CFG.disabled) return;
    const tool: string = event?.toolName ?? "";
    const cwd: string = ctx?.cwd ?? process.cwd();

    // ① 观察期：无论放行与否先记下来。不 await、失败静默 —— 观察器不能拖慢主流程
    if (CFG.observe) {
      try {
        void appendLedger(cwd, observeTool(tool, event?.input));
      } catch {
        /* ignore */
      }
    }

    if (!CFG.gated.includes(tool)) return;
    if (isEvidenceGathering(tool, event?.input)) return;

    const c = await loadContract(cwd);
    if (!c) {
      return block(
        "未登记契约：先把本次任务写成 .agent/contracts/current.json（意图两句 + 输入输出清单 + 与上次差异 + skill 偏离），再执行。",
        "可以先用只读命令取证（ls/wc/stat/cat），取证不会被执行闸拦住。",
      );
    }
    if (c.state === "escalated") {
      return block(
        "该契约已升级人工复核，闸保持关闭。",
        `请人把 ${CFG.contractPath} 里的 state 改为 approved 并填 humanNote 后再继续。`,
      );
    }

    // ① 硬校验（免费、准确）
    const manifest = await loadManifest(cwd);
    const enriched: Contract = {
      ...c,
      inputs: await enrichRefs(c.inputs, cwd, manifest),
      outputs: await enrichRefs(c.outputs, cwd, manifest),
    };
    if (JSON.stringify(enriched.inputs) !== JSON.stringify(c.inputs)) await saveContract(cwd, enriched);

    const hard = precheck(enriched, CFG.observe ? inferLineage(await loadLedger(cwd)) : undefined);
    if (hard.length) {
      enriched.state = "rejected";
      enriched.judge = hard[0];
      await saveContract(cwd, enriched);
      return block("硬校验未通过，已打回。", hard.map(verdictText).join("\n\n"));
    }

    // ② 已通过
    if (enriched.state === "approved" || enriched.judge?.verdict === "pass") {
      if (enriched.state !== "approved") {
        enriched.state = "approved";
        await saveContract(cwd, enriched);
      }
      return;
    }

    // ③ 自动裁判（每个契约最多 N 次，防死循环）
    const attempts = enriched.judgeAttempts ?? 0;
    if (attempts >= CFG.maxJudgeAttempts) {
      enriched.state = "escalated";
      await saveContract(cwd, enriched);
      return block(
        `已自动判定 ${attempts} 次仍未通过，强制升级人工。`,
        `请人复核 ${CFG.contractPath}，改 state=approved 并写 humanNote；或修正契约后重置 judgeAttempts。`,
      );
    }

    const v = await runJudge(enriched, cwd);
    enriched.judge = v;
    enriched.judgeAttempts = attempts + 1;

    if (v.verdict === "pass") {
      enriched.state = "approved";
      await saveContract(cwd, enriched);
      return;
    }

    enriched.state = v.verdict === "escalate" ? "escalated" : "rejected";
    await saveContract(cwd, enriched);
    return block(
      v.verdict === "escalate" ? "裁判无法判定，转人工。" : "裁判打回。",
      verdictText(v) + `\n\n改完 ${CFG.contractPath} 后重试；同一契约最多自动判 ${CFG.maxJudgeAttempts} 次。`,
    );
  });

  // 结果回填：让契约从「计划」变成「记录」
  pi.on("tool_result", async (event: any, ctx: any) => {
    if (CFG.disabled) return;
    const cwd: string = ctx?.cwd ?? process.cwd();

    if (CFG.observe) {
      try {
        const ev = observeTool(event?.toolName ?? "tool", event?.input ?? {});
        void appendLedger(cwd, { ...ev, kind: "tool_result", ok: !event?.isError });
      } catch {
        /* ignore */
      }
    }

    const c = await loadContract(cwd);
    if (!c || c.state !== "approved") return;
    const line = `[${new Date().toISOString()}] ${event?.toolName ?? "tool"} → ${
      event?.isError ? "ERROR" : "ok"
    }`;
    c.result = c.result ? `${c.result}\n${line}` : line;
    await saveContract(cwd, c);
  });
}

export default function (pi: ExtensionAPI) {
  contractGate(pi);
}
