# ADR 0001：Flow 定义与本机会话绑定分离

- 状态：Accepted
- 日期：2026-11-16
- 决策人：lead
- 关联：`docs/DEVELOPMENT-PLAN-v2.md`

## 背景

当前节点同时保存：

```text
sessionId
title
cwd
prompt
outputSpec
ports
x/y
```

这使一张流程图无法安全地导出给另一台机器：

- sessionId 是本地标识；
- title/cwd 可能包含私人信息；
- 别人没有同一个会话；
- 运行结果无法复现；
- 同一张图只能服务于一个 profile。

## 决策

把数据拆成三层：

```text
Flow       流程图定义，可导出、可版本化
FlowNode   工位模板，只描述角色、Skill、提示词、端口、输出契约
Binding    本机绑定，只描述 nodeId → sessionId
```

### Flow 的边界

Flow 包含：

- flowId / version / title / description；
- nodes / edges；
- 输入输出 schema；
- 示例；
- 运行要求。

Flow 不包含：

- sessionId；
- 会话标题；
- 工作目录；
- 私人备注；
- 密钥；
- 运行历史。

### FlowNode 的边界

```json
{
  "nodeId": "script_writer",
  "kind": "session",
  "role": "文稿撰写",
  "skillRefs": ["sts-card-script@1.2.0"],
  "prompt": "...",
  "outputSpec": {},
  "inputPorts": [],
  "outputPorts": [],
  "defaultOutputPortId": "out_1",
  "layout": { "x": 100, "y": 100 },
  "sessionPolicy": "existing"
}
```

`nodeId` 在流程图内稳定，导入后不变。

### Binding 的边界

```json
{
  "schemaVersion": 1,
  "flowId": "sts-card-video",
  "flowVersion": "1.0.0",
  "nodes": {
    "script_writer": {
      "sessionId": "session-xxx",
      "sessionTitle": "写作助手",
      "cwd": "..."
    }
  },
  "layoutOverrides": {},
  "updatedAt": "..."
}
```

Binding 是本机文件，不上传、不导出、不进入流程图包。

`sessionTitle` / `cwd` 只是本机显示缓存，不是流程图数据。

## 决策细节

### 1. 一个节点默认绑定一个会话

同一会话绑定多个节点默认禁止，原因是：

- 上下文会互相污染；
- 两个工位并发写同一 Session 会交错；
- 输出无法归因。

高级模式以后再开放，不作为 v2.0 默认能力。

### 2. 布局属于流程图，绑定可覆盖

- `layout` 在 Flow 中，保证导入后有默认布局；
- `layoutOverrides` 在 Binding 中，允许本机调整；
- 导出不包含本机布局覆盖。

### 3. 绑定必须可重建

导入后：

```text
未绑定 → 用户选择会话 → 校验 → 保存 binding
```

绑定不存在时，节点显示未绑定，运行被 preflight 阻断。

### 4. 绑定变更要可追踪

Binding 保存：

- 绑定时间；
- 会话 id；
- 绑定时的标题快照；
- binding revision/hash。

运行开始时把 binding 快照写入 run 目录。

### 5. sessionPolicy

v2.0 只支持：

```json
"sessionPolicy": "existing"
```

未来支持：

```text
clean   新建干净工位会话
ask     导入时选择
```

暂不实现自动建会话，避免 v2.0 范围失控。

### 6. 流程图版本与绑定版本

- Flow 有 `flowId` + `version`；
- Binding 记录 `flowVersion`；
- 流程图升级后，旧 binding 不自动套用；
- 运行记录引用 flow snapshot 和 binding snapshot。

## 后果

好的方面：

- 流程图可导出/导入；
- 不泄露 sessionId；
- 同一条流程图可以换会话复跑；
- 运行可复现；
- 官方模板可以不带任何本机会话数据。

代价：

- 数据模型和迁移更复杂；
- 导入后多一步绑定；
- UI 要显示未绑定状态；
- 老 API 需要兼容层。

## 验收

```text
导出文件中不存在 sessionId / cwd / 会话标题
导入后每个节点显示未绑定
绑定后节点显示会话
运行前未绑定被阻断
旧图迁移不丢节点/边/提示词/端口
```
