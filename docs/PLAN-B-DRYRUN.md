# B 方案：让脚本自己说（dry-run 自报）

> **什么时候看这篇**
> - A（靠读命令猜血缘）在公司误报太多，你想换一条更准的路
> - 你要做二次开发，把 B 接进 `contract-gate.ts`
> - 你只是想搞明白"检查表都有了，为什么还要 B"

---

## 0. 先跑这个（30 秒，比读文档快）

```bash
node test/plan-b/demo.ts
```

实际输出（这就是全文要说的事）：

```
指令：训练集准备好了，开始全量训推吧

─── 0. 不接 B：只看模型写的契约 ───
    [train] 训练集 → data/smoke/train.jsonl | ? · purpose=(空)
    [eval] 测试集 → data/smoke/eval.jsonl | ? · purpose=(空)
  → precheck: 放行
     （路径、行数都没问题 —— 这就是那天能一路跑到汇报的原因）

─── config.smoke.json ───
  脚本自报: scope=smoke  params={"max_steps":100,...}
  → precheck: 打回
  → B 规则  : 打回
      · 规模不匹配：脚本自报 scope=smoke，但指令要求「全量」。
      · 数据来源不匹配：data/smoke/eval.jsonl 派生自 data/full/eval.jsonl（从全量评测集随机抽 20 条）。

─── config.full.json ───
  脚本自报: scope=full  params={"max_steps":20000,...}
  → precheck: 放行
  → B 规则  : 放行
```

**同一份模型写的契约，配上 smoke 配置：不接 B 放行，接上 B 打回。**

---

## 1. B 是什么（一句话）

> **让训推脚本在真正开跑之前，先打印一份"我实际会读什么、跑多少步"的清单。**
> gate 拿这份清单，去和你的指令对。

**关键只有一点：这份清单是程序打印的，不是模型写的。**

就这么多。剩下的都是细节。

---

## 2. 那 A 是什么，为什么不够

A 是现在仓库里已经实现的那套（`contract-gate.ts` 的 `parseCmdLineage`）：

> **偷看 agent 敲的命令，从字面猜数据从哪来。**

```bash
head -n 100 data/full/eval.jsonl > data/smoke/eval.jsonl
# gate 猜：smoke 来自 full，且被抽样  ← 这次猜对了
```

**但它会误判**，因为它只认字面不认语义：

```bash
tail -n 100 train.log > last_100.log
# gate 也猜：这是抽样产物  ← 冤了
```

A 的定位因此是**兜底**：广、免费、零改动，但糙。

B 的定位是**准绳**：窄、要改脚本一次，但准。

---

## 3. 三个场景：有 B / 没 B

### 场景 1 — 你那天的事故（说全量，跑 smoke）

| | |
|---|---|
| 你的指令 | 「训练集准备好了，开始全量训推吧」 |
| 实际情况 | 沿用 skill 默认的 smoke 配置，数据是 smoke 那份 |
| **没有 B** | 路径存在、文件能读、loss 正常 → **一路跑到汇报** |
| **有 B** | 脚本自报 `scope=smoke` → 与"全量"矛盾 → **开跑前打回** |
| 靠哪个字段 | `scope`、`derived_from`、`purpose` |

### 场景 2 — 数据对了，步数没改

| | |
|---|---|
| 你的指令 | 「开始全量训推」 |
| 实际情况 | 数据换成 full 了，但 `max_steps` 还是 smoke 的 100 |
| **没有 B** | 数据表全对 → 放行 → 跑 40 分钟就"训完了"，指标难看，查半天 |
| **有 B** | 脚本自报 `params.max_steps=100` → 与全量规模明显不符 → **打回** |
| 靠哪个字段 | `params.max_steps` |

> 要判"100 步算不算全量"，需要一个参考值。在 `.agent/manifest.json` 里加：
> ```json
> { "expected_params": { "full": { "max_steps": 20000 } } }
> ```
> 没有参考值就只告警不拦（见 §6 的三档）。

### 场景 3 — 同一个路径，内容被换了

| | |
|---|---|
| 你的指令 | 「用 full/train.jsonl 跑全量」 |
| 实际情况 | 有人把 `full/train.jsonl` 重新抽成了 5 万条，路径没变 |
| **没有 B** | 路径对、行数如果没人对过 → 放行 |
| **有 B** | 行数 50000 ≠ manifest 声明 512000 → 打回；或 `sha256` 变了 → 打回 |
| 靠哪个字段 | `lines`、`sha256` |

这三个场景的共同点：**都不是"模型理解错"，而是"某个数字对不上"。** B 就是把这些数字摆出来。

---

## 4. 清单里该写什么

**原则：只写会被拿去对账的字段。不要输出整个 config。**

完整例子（`test/plan-b/dryrun.py` 的真实输出）：

```jsonc
{
  "schema": "cg.resolved/1",
  "project": "qwen3.5-mindspeed",
  "stage": "train",

  // ★ 最重要的一个字段：脚本自己承认这次按什么规模跑
  "scope": "smoke",

  "inputs": [
    {
      "role": "train",
      "path": "data/smoke/train.jsonl",
      "purpose": "smoke",
      "lines": 100,          // 现场数出来的，不是写死的
      "bytes": 3800
    },
    {
      "role": "eval",
      "path": "data/smoke/eval.jsonl",
      "purpose": "smoke",
      "lines": 20,
      "bytes": 760,
      "derived_from": ["data/full/eval.jsonl"],   // ★ 血缘，A 只能猜，B 是明说
      "derivation": "从全量评测集随机抽 20 条"
    }
  ],

  "params": { "max_steps": 100, "batch_size": 1, "seq_length": 2048 },

  "outputs": [{ "role": "ckpt", "path": "out/smoke-ckpt" }]
}
```

| 字段 | 为什么存在 | 谁填 | 能省吗 |
|---|---|---|---|
| `scope` | 全量 vs smoke，一句话就能判 | 脚本（**必须从 config 读**） | **不能省**，它是 B 的全部价值 |
| `inputs[].lines` | 抓"同路径内容被换" | 现场数 | 不能 |
| `inputs[].purpose` | 抓用途不匹配 | config | 不能 |
| `inputs[].derived_from` | 抓"用抽样数据冒充全量" | **人写在 config 里** | 不能（这是 A 猜不出的东西） |
| `params.max_steps` | 抓"数据对但规模不对" | config | 不能 |
| `outputs` | 抓"覆盖了上次的 ckpt" | config | 可以省 |
| `sha256` | 抓"同路径不同内容" | 现场算 | 大文件可省 |

**怎么决定加不加一个字段？**
> **你每出一次事故，就有某个数字对不上。把那个数字加进来。**

只加出过事的，不加"可能会出事"的。这是它不膨胀的唯一办法。

---

## 5. 怎么接（三档，按投入选）

### 档 0：最省事（5 分钟，不动训练代码）

在 `run_train.sh` 最前面加分叉：

```bash
#!/usr/bin/env bash
set -euo pipefail

if [[ "${1:-}" == "--dry-run" ]]; then
  python tools/dryrun.py --config config/train.yaml
  exit 0
fi

python train.py --config config/train.yaml
```

然后跑：

```bash
bash run_train.sh --dry-run > .agent/resolved.json
```

> 缺点：`dryrun.py` 和 `train.py` **各自解析一遍 config**，容易漂移
> （改了一处忘了另一处 → 自报的和实际跑的不一样 → 这份清单就没意义了）。
> 所以只要条件允许，直接上档 1。

### 档 1：推荐（半小时）

把 config 解析抽成一个函数，dry-run 和真跑共用：

```python
# tools/config.py
def load_resolved(path):
    cfg = parse_yaml(path)
    # ... 展开默认值、环境变量、继承 ...
    return cfg          # ← 唯一出口

# tools/dryrun.py
cfg = load_resolved(args.config)
print(json.dumps(summarize(cfg), ensure_ascii=False, indent=2))

# train.py
cfg = load_resolved(config_path)   # ← 同一份
train(cfg)
```

这样"自报的"和"实际跑的"**结构上不可能不一致**。

### 档 2：全入口（长期）

`train` / `eval` / `infer` / 平台提交，每个入口都吐 `resolved.json`。

---

## 6. gate 侧怎么接（这就是二次开发的部分）

### 6.1 规则（三条，就是 demo 里的 `checkB`）

```ts
const FULLISH = /(全量|完整|full|正式|最终)/i;

function checkB(c: Contract, r: Resolved): string[] {
  const out: string[] = [];
  const wantsFull = FULLISH.test(c.instruction);

  // 1. 脚本自报的规模 vs 指令要求的规模
  if (wantsFull && r.scope !== "full") {
    out.push(`规模不匹配：脚本自报 scope=${r.scope}，但指令要求「全量」。`);
  }
  // 2. 要全量，但某路数据是派生（抽样/切分）出来的
  for (const i of r.inputs) {
    if (wantsFull && i.derived_from?.length) {
      out.push(`数据来源不匹配：${i.path} 派生自 ${i.derived_from.join(", ")}`);
    }
  }
  // 3. 脚本声明的缺失文件
  for (const i of r.inputs) {
    if (i.bytes === null) out.push(`数据缺失：${i.path} 不存在`);
  }
  return out;
}
```

### 6.2 合并（脚本的事实覆盖模型的自述）

```ts
function merge(c: Contract, r: Resolved): Contract {
  const byRole = new Map(r.inputs.map((i) => [i.role, i]));
  return {
    ...c,
    inputs: c.inputs.map((inp) => {
      const hit = byRole.get(inp.role);
      if (!hit) return inp;
      return { ...inp, resolved: {
        path: hit.path, lines: hit.lines ?? undefined,
        bytes: hit.bytes ?? undefined, purpose: hit.purpose,
      }};
    }),
  };
}
```

### 6.3 要改的三个位置

| # | 在哪 | 改什么 |
|---|---|---|
| 1 | `CFG` | 加 `resolvedPath: process.env.CG_RESOLVED \|\| ".agent/resolved.json"` |
| 2 | `contractGate` 的 `tool_call` 里，`enrichRefs` 之后 | 读 resolved.json，`merge()` 覆盖，再跑 `precheck` 和 `checkB` |
| 3 | `precheck` 之后、`runJudge` 之前 | B 的结论按 §6.4 的三档处理 |

### 6.4 三档力度（按你的信任度选）

```
CG_RESOLVED=enforce    # 打回（默认，保护优先）
CG_RESOLVED=warn       # 只写进契约留痕，不进 block
CG_RESOLVED=off        # 不看
```

**建议先 `warn` 跑一周**，看误报率，再切 `enforce`。

### 6.5 注意：不要扔掉 A

B 只覆盖"接了 dry-run 的入口"。没接的入口（手工命令、临时脚本）还需要 A 兜底。

```
B（准，但覆盖面窄）  →  主力
A（糙，但全覆盖）    →  兜底
两者都对不上时才找人  →  升级
```

---

## 7. 你的场景可能不是"直接跑脚本"

如果任务是提交到平台（不是一个你能改的 shell 脚本）：

**方案 A：提交前本地跑一次**
```bash
bash run_train.sh --dry-run > .agent/resolved.json   # 本地
# 然后提交，resolved.json 跟着任务一起带上去
```

**方案 B：平台侧 wrapper**
在提交任务的入口脚本最前面插同样的分叉。本质一样，只是位置提前。

**方案 C：退化成"配置回读"**
平台提交后能读到最终生效配置的话，把那份配置转成 `resolved.json` 也行——**关键是这个 JSON 必须是程序生成的，不能是人手抄的。**

---

## 8. 验收清单（接完自己验）

| # | 做什么 | 期望 |
|---|---|---|
| 1 | `python tools/dryrun.py --config config/smoke.yaml` | 输出合法 JSON |
| 2 | 输出里的 `lines` 和 `wc -l` 手数 | 一致 |
| 3 | 把 config 里数据路径改成 full，再跑一次 | JSON 跟着变（**没变说明写死了**） |
| 4 | 把 `scope` 在 config 里改成 `full`，跑 | JSON 里 `scope` 也变（**这一步最关键**） |
| 5 | `node test/plan-b/demo.ts` | smoke 打回、full 放行 |

第 3、4 步是防"假 dry-run"的：如果 `dryrun.py` 里硬编码了 `"scope": "full"`，那它就是另一份自我报告，等于白做。

---

## 9. 不要做（防止它长成第二个配置中心）

- ❌ **不要在清单里写"意图"**（"我要做全量训推"）—— 那是模型的事。程序只报事实。
- ❌ **不要输出整个 config** —— 只输出会被判定的字段，否则没人看。
- ❌ **不要硬编码任何数字** —— `scope`、`lines` 都必须从现场取。
- ❌ **不要引入新依赖** —— 只用标准库，否则公司环境装不上就等于没做。
- ❌ **不要为了"通用"设计 schema** —— 为你的训推流程设计就够了。

---

## 10. 一图说清三者关系

```
指令：       「开始全量训推」                    ← 人
契约：       我理解成一次完整训推，计划改 3 处配置  ← 模型写（照出误解）
resolved：   data/full/train.jsonl · 512000 行    ← 程序验（挡住幻觉）
B 自报：     scope=smoke · max_steps=100          ← 脚本自报（挡住"跑错了东西"）
血缘 A：     smoke ← full（抽样）                  ← 猜（兜底）
──────────────────────────────────────────────
对账：       三行摆在一起，人 3 秒看完
```

**检查表不是用来采集事实的，它是"事实"和"意图"碰头的桌面。**
程序负责把事实端上来，模型负责把理解端上来，人是那个说"这俩对不上"的人。

---

## 11. 什么时候值得上 B

不是所有项目都值得。判断标准：

| 情况 | 建议 |
|---|---|
| 只跑一个项目，A 的误报你能忍 | **A 就够**，别折腾 |
| A 误报明显（比如经常把日志操作当成抽样） | **上 B** |
| 项目 ≥ 2 个，每个都想护住 | **上 B**（一次投入，长期复用） |
| 训练一次 ≥ 2 小时 / 花钱 | **上 B**（误跑一次的代价远超接入成本） |
| 事故里"数字对不上"占多数 | **上 B**（B 就是为数字设计的） |

---

## 12. 仓库现状（诚实说明）

| | 状态 |
|---|---|
| A（命令解析血缘） | ✅ 已实现在 `contract-gate.ts` |
| 检查表 / 硬校验 / 独立裁判 / 观察期账本 | ✅ 已实现 |
| B（dry-run 自报） | ⚠️ **只到 demo**，`test/plan-b/` 下可运行，**没有接进 `contract-gate.ts`** |

没接的原因：字段设计要贴着你们真实的训推脚本，不然又是一个填不满的表。等你公司的脚本长什么样确定了，按 §6 接进去就是半天的事。
