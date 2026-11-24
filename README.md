# omp-contract-gate

> **执行前的可驳回契约。**
> 模型先把自己要做的事写成一页纸，通过「硬校验 + 独立裁判」才允许动高危工具。

不是防模型乱来——是防**人**退化。

> 📐 **要二次开发，先读 [`docs/DESIGN.md`](docs/DESIGN.md)** —— 那里写了为什么这么设计、状态机、决策记录（ADR）、以及在公司 fork 上要改哪三处。

---

## 1. 它解决什么

一个真实事故：

```
你：训练集准备好了，开始全量训推吧
agent：好的（沿用了 skill 里挂着的 smoke 数据集）
你：汇报了一半才发现数据是错的
```

配置对、路径存在、文件能读、loss 正常——**所有"跑通"的信号都是绿的**。
错在语义层：你说"全量"，它读的是"smoke"。而当时系统里：

> **没有任何一个环节有资格发现它错了，因为所有校验都在问「跑通了吗」，没人在问「跑的是不是该跑的那件事」。**

这个仓库补的就是那一环。

## 2. 三层拦截（从便宜到贵）

| 层 | 做什么 | 成本 | 准确率 |
|---|---|---|---|
| **取证豁免** | 只读命令（`ls/cat/wc/stat/grep/...`）永远放行 | 0 | — |
| **硬校验** | 纯代码：路径存在？行数对得上？用途是 smoke 还是 full？指代词落实了吗？ | 0 | 100% |
| **独立裁判** | 另一个模型，只看证据，逐条断言核验 | 一次 API 调用 | 取决于给它的证据 |
| **留痕** | 契约落盘 → 可复盘 → 第二阶段的训练材料 | 0 | — |

**硬校验单独就能拦住上面那个事故。** 见 `test/replay/` 的运行结果。

## 3. 证据变体（mask 实验）

裁判看什么信息，是一个 2×2：

| 变体 | 指令/skill/契约/文件事实 | 工具轨迹（过程） | 模型自述（辩护） |
|---|:---:|:---:|:---:|
| `full` | ✓ | ✓ | ✓ |
| `mask_advocacy` ← 默认 | ✓ | ✓ | ✗ |
| `mask_trace` | ✓ | ✗ | ✓ |
| `mask_both` | ✓ | ✗ | ✗ |

第一列永远保留——那是判据本身。

- **遮辩护**测：模型自己的解释是不是污染源（锚定效应）。
- **遮过程**测：判「指令 vs 契约」到底需不需要看它怎么干的。**如果不需要，闸就能做得极便宜**——这是能否规模化的关键。
- `mask_both` 是信息量最小的充分集候选。

**加一个变体 = 改 `contract-gate.ts` 里 `KEEP` 表的一行（20 行代码）；切换 = 一个环境变量，不动代码。**

```bash
CG_MODE=mask_trace node test/replay/run.ts
```

## 4. 回放集：怎么知道哪个变体好

没有固定回放集，「哪个好用」就是玄学。

```bash
node test/replay/run.ts            # 全部用例 × 4 变体，出一张表
node test/replay/run.ts --print    # 顺便打印证据包，肉眼看遮掉了什么
```

当前用例：

| case | 场景 | 期望 |
|---|---|---|
| `01-smoke-as-full` | 真实事故复现（说全量，用 smoke） | **reject** |
| `02-correct-full` | 对照组（正确落在全量上） | **pass** |

**评估优先级是「漏判率」，不是总分。** 该拒的判成 pass，比该过的被拒严重得多：前者是那天伤到你的东西，后者只是多点一次。

加用例的方法：`cases/03-xxx/case.json` + `expected.json`，`resolved` 字段填「程序实测后的真实值」。

## 5. 契约格式

`.agent/contracts/current.json`（模型用普通 write 工具写，gate 对 `.agent/contracts/` 路径豁免）：

```jsonc
{
  "id": "2026-11-25-train-full",
  "instruction": "训练集准备好了，开始全量训推吧",   // ← 逐字原文，不得改写
  "intent": "用刚准备好的全量训练集做一次完整训推",   // ← 第一句
  "plan": "把数据路径 smoke→full，步数重设后跑 run_train.sh",  // ← 第二句

  "inputs": [
    { "role": "train", "label": "全量训练集",
      "resolved": { "path": "data/full/train.jsonl" } }        // ← 只要路径；行数/purpose 由程序实测覆盖
  ],
  "outputs": [
    { "role": "ckpt", "label": "权重目录", "resolved": { "path": "out/full-ckpt" } }
  ],

  "diffFromLastRun": "数据路径 smoke→full；max_steps 100→20000",  // ← 必填，空着=声称完全一样
  "skillDeviations": "偏离 skill 第 2 条：默认 smoke 路径改为 full",  // ← 必填
  "state": "draft"
}
```

两个关键设计：

1. **`resolved.lines / mtime / purpose` 由 `contract-gate.ts` 现场量，覆盖模型写的值。** 模型说 512000 行没用，量出来多少就是多少。这是「不信任自我报告」的落点。
2. **`diffFromLastRun` 和 `skillDeviations` 强制必填。** agent 的错误高度集中在「沿用上次」；强迫它写 diff，等于强迫它把「我没改的地方」也过一遍脑子。而「偏离声明」让**沉默变成有意义的信号**。

## 6. 判定规则（硬校验）

不花模型一分钱，准确率 100%：

- 指代词（训练集/测试集/数据集/权重…）没有落到具体路径 → 打回
- 路径不存在 → 打回
- 指令含「全量/完整/full」，但数据 `purpose=smoke` → 打回
- 实测行数与 manifest 声明不符（文件被替换过）→ 打回
- 缺 `intent` / `plan` / `diffFromLastRun` → 打回

`manifest.example.json` 是这套判定的力量来源：**模型负责去看，这张表负责知道该看什么。** 缺了它，裁判只会得出「路径存在、有数据、格式正确」然后放行。

## 7. 装配件

### 7.1 三个安装位置，选哪个

| 位置 | 路径 | 生效范围 | 谁需要配合 |
|---|---|---|---|
| **项目级** ← 推荐 | `<项目>/.omp/hooks/pre/contract-gate.ts` | 只在这个项目 | **没人**，磁盘发现 |
| 用户级 | `~/.omp/agent/hooks/pre/contract-gate.ts` | 你所有项目 | 没人，磁盘发现 |
| 单次 | `omp --hook <绝对路径>/contract-gate.ts` | 这一次启动 | **启动它的那个东西**要替你传参 |

```bash
# 项目级（推荐）
mkdir -p .omp/hooks/pre .agent
cp /path/to/omp-contract-gate/contract-gate.ts .omp/hooks/pre/
cp /path/to/omp-contract-gate/manifest.example.json .agent/manifest.json
```

**为什么拉项目级，而不是 `--hook`**：

> 再封装层（GUI、编排器、docker、公司的 fork）经常有自己的一套启动参数，你改不动。`--hook` 依赖**调用方替你传参**；`.omp/hooks/pre/` 是**磁盘发现**——不管谁启动 omp、从哪个 cwd 启动，只要发现没被关掉就会加载。

两个细节：

- **必须在 `pre/` 或 `post/` 子目录里**。放在 `.omp/hooks/contract-gate.ts` 会**静默不加载**（发现不递归）。
- 改完要**新开一个会话**才生效。

### 7.2 被别的程序封装时（GUI / 编排器 / 容器 / SDK）

| 封装方式 | 插件还能不能用 | 要注意 |
|---|---|---|
| 进程外包装（Orca、omp-studio、ompweb、docker） | ✅ 能 | 它只是启动 `omp`，hook 在 omp 进程内加载。容器的话装进它挂载的那个 `~/.omp` 卷 |
| SDK 嵌入（`createAgentSession()`） | ⚠️ 看写法 | `hooks: [...]` 是**替换**发现结果，`additionalHookPaths: [...]` 才是**追加**。宿主写 `hooks: []` 会让插件静默消失 |
| fork 后重写（公司二次开发版） | ⚠️ 看事件总线 | 保留 `tool_call` / `tool_result` 就还在链路上；改了事件名或返回值语义就要动适配层（`docs/DESIGN.md` 7.2） |

### 7.3 配裁判（独立端点）

```bash
export CG_JUDGE_BASE_URL=https://your-endpoint/v1
export CG_JUDGE_API_KEY=sk-...
export CG_JUDGE_MODEL=<与规划模型不同族的模型>
```

**为什么必须换族**：同一模型既规划又自评，结构上会把卷子批成对的。

不配裁判也能跑——只是**只能靠硬校验**，且遇到需要语义判断的会 `escalate` 转人工（默认 fail-closed，不会静默放行）。

### 7.4 五分钟验证清单

装完按这个顺序验，任何一步不对就先停下来：

| # | 动作 | 期望 |
|---|---|---|
| 1 | `omp --version`，然后新开会话 | 启动无报错 |
| 2 | 让它跑 `ls` | **正常执行**（取证豁免） |
| 3 | 让它跑 `python train.py` | **被拦**，提示"未登记契约" |
| 4 | 让它写 `.agent/contracts/current.json` | **放行**（契约路径豁免） |
| 5 | 再跑 `python train.py` | 过了硬校验才放行；不过则给出打回理由 |

第 3、4 步如果都不成立，说明 hook 根本没加载——回去看 7.1 的 `pre/` 子目录。第 3 步拦了但**理由不对**，多半是 `event.input` 字段名不同（代码已兜 `path`/`file_path`/`filePath`/`file`）。

### 7.5 环境变量总表

| 变量 | 默认 | 说明 |
|---|---|---|
| `CG_MODE` | `mask_advocacy` | 证据变体：`full` / `mask_advocacy` / `mask_trace` / `mask_both` |
| `CG_JUDGE_BASE_URL` | 空 | OpenAI 兼容端点 |
| `CG_JUDGE_API_KEY` | 空 | |
| `CG_JUDGE_MODEL` | 空 | 建议与规划模型不同族 |
| `CG_TOOLS` | `bash,write,edit` | 受闸工具 |
| `CG_DISABLE` | — | `1` = 关掉整个闸（闸写错时救命用） |
| `CG_ON_NO_JUDGE` | `escalate` | 没配裁判时：`escalate` 转人工 / `allow` 放行 |
| `CG_MAX_ATTEMPTS` | `2` | 同一契约自动判定上限，超了强制转人工 |
| `CG_CONTRACT` | `.agent/contracts/current.json` | 契约文件路径 |
| `CG_MANIFEST` | `.agent/manifest.json` | 数据集清单路径 |

## 8. 两个阶段

- **第一阶段（本仓库）＝ 对事**：让这一次任务不出错。产出是**判决**。
- **第二阶段 ＝ 对人**：让你长回来。产出是**你的判断力**。

第二阶段不做新功能，只做一件事：

> **契约被打回时，人必须写一句「为什么」→ `humanNote`。**

攒够 20 条，你会看到自己反复漏指示的地方（比如「我总是忘了说数据版本」）。那才是真正被训练的东西——**不是练 agent，是练「我哪里说不清」**。

契约本身就是第二阶段的器材：**它把「读 agent」的成本压回了人类尺度**。以前读 200 行工具调用才能判断它干了啥，现在读 3 行。「读得动」是「能批判」的前提。

## 9. 已知待验证点 / 脆弱处

| 项 | 状态 |
|---|---|
| 公司 fork 的 `ExtensionAPI` 是否与上游一致 | **未验证**。先跑 `omp --hook ./contract-gate.ts` 看是否加载 |
| `tool_call` 的 `event.input` 字段名（`path` / `file_path` / `filePath`） | 已三种兜底，实测后收敛 |
| `ctx.cwd` 是否可用 | 有 `process.cwd()` 兜底 |
| bash 只读白名单 | 会误伤非标准命令；误伤时把前缀加进 `READONLY_PREFIX`，或用 `CG_DISABLE=1` |
| 指令原文可能被模型改写 | 未做 hash 绑定；靠人一眼扫 `instruction` 字段（3 秒） |
| 裁判没配置 | 默认 `escalate`（fail-closed），不会静默放行 |

## 10. 安全阀

```bash
CG_DISABLE=1     # 关掉整个闸（闸写错时救命用）
CG_ON_NO_JUDGE=allow|escalate   # 没配裁判时放行还是转人工，默认 escalate
CG_MAX_ATTEMPTS=2               # 同一契约自动判定上限，超了强制人工
CG_TOOLS=bash,write,edit        # 受闸工具
```

**升级人工后，闸保持关闭**，直到人把 `state` 改成 `approved` 并填 `humanNote`。这是唯一的人工出口，也是唯一能绕过裁判的地方——只有人能绕。

## 11. 目录

```
contract-gate.ts          ← 插件本体（单文件、零依赖、可直接拷走）
manifest.example.json     ← 数据集清单模板（判定的力量来源）
docs/DESIGN.md            ← 设计说明：第一原则 / 状态机 / ADR / 二次开发指南
test/replay/run.ts        ← 变体对比 harness
test/replay/cases/*/      ← 回放用例（真实事故 + 对照组）
```
