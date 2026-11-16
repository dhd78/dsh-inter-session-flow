# Changelog

## 2.0.0 — 2026-11-16

- 正式发布：由 `2.0.0-m6.2` 提升为 `2.0.0`；
- 包名 `dsh-inter-session-flow`，MIT；
- E/F 未纳入正式验收：同 run 重试有本地手工验证，sent-no-output 仍为人工处理；
- 公开包保留原创示例 `examples/research-to-review.flow.json`。

## 2.0.0-m6.2 — P3 修复

- 修复 Skill 面板切换节点后仍保持展开的问题。
- 原因是 `selectedNode` 实际保存的是字符串 id，effect 依赖写成了 `selectedNode?.id`，始终为 `undefined`。
- 改为依赖 `selectedNode` 本身。

## 2.0.0-m6.1 — 验收修复

- 修复 `POST /import` 的 `root is not defined`。
- `POST /run` 空输入改为 400 `empty-input`。
- Skill 面板切换节点时恢复折叠默认态。
- 同一 interrupted run 只允许 resume 一次：
  - 源 run 写入 `resumeConsumed` / `resumedBy`；
  - 第二次 resume 返回 409 `already-resumed`。

## 2.0.0-m6.0 — M6 运行留痕与恢复

- 新增 `state.json` 运行快照：`ready / active / joins / cursors`。
- 新增稳定 `messageId = <runId>:<jobId>:primary` 与 `afterSeq`。
- 新增 delivery ledger：同一 delivery 不重复投递。
- 新增崩溃恢复：
  - `POST /run/reconcile`
  - `POST /run/resume`
  - 未发送的 running 节点自动恢复；已发送无输出转人工确认。
- 重试改为同 run 继续，保留 join 队列。
- 新增运行历史恢复 UI：
  - 恢复运行；
  - 检查中断节点；
  - 查看输出；
  - 采纳并继续；
  - 重试并继续下游；
  - 放弃分支。
- 新增 `POST /run/adopt` / `POST /run/abandon`。
- 并行 + all join、分支 join 重试、4 工位 + 2 Skill 真实流程图通过。

## 2.0.0-m1.1 — M1 修正

- 修复 M1.1 测试包中的删除、重命名、导入副本等问题。

- 命名调整：
  - `flowId` / `flowVersion` / `flowHash` / `flowContent`
  - API `/flows`
  - 存储 `flows/`
  - 包字段 `flow`
- 包格式：`packageVersion:2` / `flow.schemaVersion:3`。
- 旧 `lines/` 迁移到 `flows/`，备份保留。
- `graph.json` 保留 1.0.x 兼容层。
- 新增 flow 库、导入、导出、preflight。
- 流程图库支持软删除：移到 `trash/`，同时移走 binding。
- 流程图支持改名（`PATCH /flows/:id`）。
- 导入同名流程图不再覆盖：自动 `flowId-2`、标题 ` (2)`，原图不变。
- **Breaking**：`packageVersion:1` 旧包明确拒绝，不静默接受；v1→v2 迁移器在 M1 后提供。

## 1.0.2 — 2026-11-15

- 修复停止运行后节点状态残留 `running`；
- 停止时将运行中的节点落为 `stopped`；
- 新增 `node-stopped` 运行事件；
- 覆盖 00 测试报告中的 C4。

## 1.0.1 — 2026-11-15

- 补齐中文模式的硬性输出线 / 可回退输出线名称；
- 连线模式允许点击节点查看、修改节点属性；
- 重新进入插件面板时从 Host 恢复当前运行状态和最近一次运行结果。

## 1.0.0 — 2026-11-15

首个产品化版本。

### 核心

- 会话间执行图，节点绑定已有顶层会话；
- 节点模式 / 连线模式 / 运行模式；
- 每节点最多 3 个输入口和 3 个输出口；
- 输入口策略：`each`、`all`；
- 输出口策略：`all`、`roundRobin`；
- 默认输出口和结果级 `target`；
- 硬性输出线、可回退输出线（回退执行预留）；
- 边指令、节点提示词、文本 / JSON 输出契约；
- JSON 解析失败自动重试一次；
- 多分支并行执行，分支失败隔离；
- 运行停止与 JSON 运行日志。

### 界面

- 画布拖动、缩放、平移、重置视图；
- 端口级连线，带虚线预览和输入口吸附；
- 中英文界面切换；
- 六套局部配色。

### 安全

- 使用 `agent-message` / `relay` 投递；
- 不冒充用户输入，不提升目标会话权限；
- 不依赖 `dsh-telephone`。

### 已知限制

- 可回退线尚未接入真实回退执行；
- 条件输出尚未实现；
- 不设自动超时；
- 单节点最多 10 个结果，字段路由以 `x` 为主。
