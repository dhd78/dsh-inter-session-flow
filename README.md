# 会话间流程 / Inter-session Flow

把多个已有的 DSH 会话组织成一条真正会执行的工作流：会话之间自动交接任务、并行处理、汇总结果。

| 项 | 值 |
| --- | --- |
| 版本 | `2.0.0` |
| 形态 | DSH 插件 bundle（Host + Client） |
| 平台 | DSH Web / Desktop |
| 数据 | `%DSH_HOME%/inter-session-flow/` |
| 许可 | MIT |

---

## 面向问题

一个会话同时做资料搜集、写作、审查和汇总，迟早会角色漂移、上下文膨胀、输出互相污染。把工作拆到多个专用会话是自然做法，但拆开之后，交接靠人复制粘贴，效率低下。

会话间流程解决的就是这一点：**会话之间的交接，只要像流程图一样设计好一个流程产线，一句话就可以完成整个复杂任务**。

```text
研究 → 写作 → 审查 → 汇总
```

每个会话保持专一，交接由引擎完成，结果按规则流向下一站。

---

## 插件简介

- 这是一个**跨会话执行图**：节点绑定已有会话，端口和连线定义交接；
- 流程可以**导入、导出、改名、软删除**，导入前可预检；
- 支持**输入口策略** `each` / `all`，**输出口策略** `all` / `roundRobin`；
- 支持**边指令**、**节点提示词**、**文本 / JSON 输出契约**；
- 支持 **Skill 包与锁**：流程图可声明依赖的 Skill，并校验内容哈希；
- 支持**并行分支**、失败隔离、运行停止与运行日志；
- 支持**运行快照、中断检测、恢复、人工采纳/放弃、同 run 重试**；
- 中英文界面、6 套局部配色。

## 插件界限

- 不可循环连接；
- 不创建、不复制会话，只复用已有顶层会话；
- 不替代 DSH 的会话权限系统，也不提升目标会话权限。

---

## 核心能力

### 1. 会话保持专一

每个节点只负责自己的职责与上下文。研究、写作、审查、汇总各用一个会话，互不污染。

### 2. 分支可以并行

一个输出口可以连多条下游边，引擎并行启动不同节点的任务；同一节点内部仍串行，避免同一会话被并发写入。

```text
        ┌→ 章节 A
大纲 ───┼→ 章节 B
        └→ 章节 C
```

三条分支同时跑，最后一个汇总节点收齐。

### 3. 交接是有契约的

- **边指令**：写在连线上，例如 `请把 {{input-x}} 加上 5`；
- **节点提示词**：写在节点上，例如 `你是计算器，只返回 JSON results`；
- **输出契约**：文本，或 JSON `results` 数组，结果可带 `target` 指定输出口。

### 4. 多结果可分流

```json
{
  "results": [
    { "x": "结果1", "target": "out_1" },
    { "x": "结果2", "target": "out_2" },
    { "x": "结果3" }
  ]
}
```

带 `target` 的结果走指定输出口，没有 `target` 的走默认输出口；输出口策略只作用于被选中的口。

### 5. 多上游可汇合

输入口设为 `all` 时，该口连接的所有硬性输入线到齐后合并执行一次。

### 6. 流程图库与 Skill 包

- 流程图可导入 / 导出为 JSON 包，导入前预检，同名导入不覆盖；
- 流程图可声明引用的 Skill，记录版本、来源与内容哈希；
- 运行前检查 Skill 锁，内容变化会报 `content-hash-mismatch`。

示例流程见 `examples/research-to-review.flow.json`。

### 7. 运行留痕与恢复

- 每个 run 保存快照与事件，写 `runs/<runId>/state.json`；
- 稳定 `messageId` / `afterSeq`，同一投递不会重复；
- 中断后 `POST /run/reconcile` 检测，`POST /run/resume` 恢复（同一源 run 只允许一次）；
- 已发送但无输出、分支 join 失败等场景可人工处理：采纳输出、重试、放弃分支；
- 运行历史可在 UI 中恢复与查看。

### 8. 不提升权限

任务通过 `agent-message` / `relay` 投递给目标会话，目标会话看到的是外部任务消息，不是用户输入；插件不会提升或绕过目标会话的权限。

---

## 快速开始

### 1. 安装

在 DSH 的插件管理中安装本 bundle（或使用 `plugin_manager` 安装本地包目录），安装后刷新页面。

侧栏出现「会话间流程」入口即安装成功。

### 2. 导入或新建流程

- 导入：`examples/research-to-review.flow.json`，或自己的流程包；
- 新建：从左侧「选择已有会话」添加节点。

### 3. 绑定会话

每个节点绑定一个已有顶层会话。归档会话、子会话、Subagent 会话与空会话不会出现在列表里。

### 4. 配置节点与连线

选中节点设置提示词、输出格式、默认输出口、输入 / 输出策略与端口数量；连线模式里选择「硬性输出线」或「可回退输出线」，再填写边指令。

### 5. 运行

选择起始节点，填写运行输入，点击「运行」。运行面板显示每个节点的状态与输出。

### 6. 中断后恢复

打开运行历史，检查中断节点，选择恢复运行、采纳输出并继续、重试下游或放弃分支。

---

## 概念模型

```text
Flow
  Node   绑定一个已有会话
    InputPort   接收上游输出
    OutputPort  发送本节点输出
  Edge   从一个输出口连到一个输入口
  Skill  流程图声明的外部能力包与锁
Run      一次执行，含快照、事件与恢复状态
```

| 概念 | 说明 |
| --- | --- |
| 节点模式 | 拖动节点、编辑属性 |
| 连线模式 | 选口、连线、写边指令 |
| 运行模式 | 选起点、填输入、运行与查看状态 |
| 流程库 | 导入、导出、改名、软删除、预检 |
| 运行历史 | 恢复、检查中断、采纳、重试、放弃 |

### 输入口

| 策略 | 行为 |
| --- | --- |
| `each` | 每条输入线到达时执行一次 |
| `all` | 所有已连接的硬性输入线到齐后合并执行一次 |

### 输出口

| 策略 | 行为 |
| --- | --- |
| `all` | 该口连接的每条线都收到结果 |
| `roundRobin` | 多个结果按连线顺序轮询分发 |

### 输出契约

文本模式：

```json
{ "output": "任意文本" }
```

JSON 模式：

```json
{
  "results": [
    { "x": "…", "target": "out_1" },
    { "x": "…", "target": "out_2" }
  ]
}
```

- 每个结果可带 `target`，定向到指定输出口；不带时走默认输出口；
- 字段可用 `x` / `y`，在边指令中分别用 `{{input-x}}` / `{{input-y}}` 引用；
- JSON 解析失败会自动重试一次；仍失败则记为节点错误，不影响其他分支。

---

## 数据与 API

### 数据

```text
%DSH_HOME%/inter-session-flow/
  flows/                 流程图
  runs/<runId>/          运行记录与快照
  bindings/              会话绑定
```

### HTTP API

```text
GET  /api/inter-session-flow/graph
GET  /api/inter-session-flow/sessions
GET  /api/inter-session-flow/flows
POST /api/inter-session-flow/import
POST /api/inter-session-flow/import/preview
GET  /api/inter-session-flow/skills
GET  /api/inter-session-flow/run
POST /api/inter-session-flow/run
POST /api/inter-session-flow/run/stop
POST /api/inter-session-flow/run/retry
POST /api/inter-session-flow/run/resume
POST /api/inter-session-flow/run/reconcile
POST /api/inter-session-flow/run/adopt
POST /api/inter-session-flow/run/abandon
GET  /api/inter-session-flow/runs
```

---

## 兼容性与升级

- 包格式 `packageVersion: 2`，流程图 `schemaVersion: 3`；
- 旧 `packageVersion: 1` 包会被明确拒绝，不会静默接受；迁移说明见 `docs/migration-v1-to-v2.md`；
- 1.0.x 的 `graph.json` 保留兼容层；
- 升级时先移除旧 bundle，再安装新目录，刷新页面后生效；
- 依赖 DSH 的 `webServer`、`sessionQuery`、`agents`、`sessionController` 服务。

---

## 已知限制

- E/F 未纳入正式验收：同 run 重试有本地手工验证；
- sent-no-output 仍为人工处理（采纳或放弃），未做自动处理；
- 没有 v1→v2 流程包自动迁移器，只提供迁移说明；
- `all` 输入口要求所有已连接硬性线到齐，缺一支会报 `incomplete-join`；
- 单节点最多 3 个输入口 / 3 个输出口，最多 10 个结果；
- 不设自动超时，长任务需要手动停止；并行任务上限 8；
- 暂无 Marketplace 与自动更新。

---

## 故障排查

| 现象 | 检查 |
| --- | --- |
| 侧栏没有入口 | bundle 是否启用；刷新页面；是否有重复面板 key |
| 导入被拒 | 包 `packageVersion` 是否为 2；流程图 `schemaVersion` 是否为 3 |
| 运行没有触发下游 | 边的方向；结果的 `target`；输出口策略；`all` 是否到齐 |
| 节点报格式错误 | 输出是否为 JSON `results`；字段与数量是否超出 `outputSpec` |
| 中断后无法恢复 | 同一源 run 只能 resume 一次；检查 `resumeConsumed` |
| Skill 报哈希不一致 | 重新生成 Skill 锁，或确认 Skill 内容未被修改 |

---

## 许可

MIT，Copyright (c) 2026 dhd (https://github.com/dhd78)。见 `LICENSE`。

---

## English

**Inter-session Flow** turns existing DSH sessions into an executable workflow graph. Bind sessions as nodes, connect output ports to input ports, and let the engine hand off tasks, run branches in parallel, merge results and recover interrupted runs.

| Item | Value |
| --- | --- |
| Version | `2.0.0` |
| Form | DSH plugin bundle (Host + Client) |
| Platform | DSH Web / Desktop |
| Data | `%DSH_HOME%/inter-session-flow/` |
| License | MIT |

### What it does

- an **executable cross-session graph** with nodes, ports and edges;
- **flow library**: import, export, rename, soft delete and preflight;
- **input strategies** `each` / `all`, **output strategies** `all` / `roundRobin`;
- **edge instructions**, **node prompts**, and **text or JSON output contracts**;
- **Skill packages and locks**: declare skills, record versions and content hashes, verify before running;
- **parallel branches**, failure isolation, run stop and run logs;
- **run snapshots and recovery**: reconcile, resume once per source run, adopt output, retry, abandon a branch;
- Chinese / English UI, six local color themes.

### Boundaries

- no cyclic connections;
- does not create or copy sessions — it reuses existing top-level sessions;
- does not replace or elevate DSH session permissions.

### Quick start

1. Install the bundle from the DSH plugin manager (or install the local package directory with `plugin_manager`), then refresh the page.
2. Import `examples/research-to-review.flow.json` or build a flow from existing sessions.
3. Bind one existing top-level session per node.
4. Configure prompts, output format, default output port and port strategies; wire ports and add edge instructions.
5. Run from a start node and watch node states and outputs.
6. After an interruption, open run history to resume, adopt, retry or abandon.

### Data and API

```text
%DSH_HOME%/inter-session-flow/
  flows/
  runs/<runId>/
  bindings/
```

```text
GET  /api/inter-session-flow/graph
GET  /api/inter-session-flow/sessions
GET  /api/inter-session-flow/flows
POST /api/inter-session-flow/import
POST /api/inter-session-flow/import/preview
GET  /api/inter-session-flow/skills
GET  /api/inter-session-flow/run
POST /api/inter-session-flow/run
POST /api/inter-session-flow/run/stop
POST /api/inter-session-flow/run/retry
POST /api/inter-session-flow/run/resume
POST /api/inter-session-flow/run/reconcile
POST /api/inter-session-flow/run/adopt
POST /api/inter-session-flow/run/abandon
GET  /api/inter-session-flow/runs
```

### Compatibility

- package format `packageVersion: 2`, flow `schemaVersion: 3`;
- `packageVersion: 1` packages are rejected explicitly; see `docs/migration-v1-to-v2.md`;
- 1.0.x `graph.json` keeps a compatibility layer;
- upgrade by removing the old bundle, installing the new directory and refreshing.

### Known limits

- E/F were not part of the formal acceptance: same-run retry has local manual verification, sent-without-output stays manual;
- no automatic v1 → v2 package migrator;
- `all` input ports require every connected hard edge; a missing one reports `incomplete-join`;
- max 3 input / 3 output ports per node; max 10 results per node;
- no automatic timeout; parallel jobs capped at 8;
- no Marketplace or auto-update yet.

**License**: MIT, Copyright (c) 2026 dhd (https://github.com/dhd78).
