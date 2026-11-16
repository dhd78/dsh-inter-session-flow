# 1.0.x → 2.0.0 迁移映射

- 日期：2026-11-16
- 源版本：1.0.2（graph version 2）
- 目标：flow schema 2 + binding schema 1
- 原则：不丢字段、不覆盖旧文件、可回滚

## 一、旧数据

```text
%DSH_HOME%/inter-session-flow/graph.json
%DSH_HOME%/inter-session-flow/runs/*.json
```

旧 graph：

```json
{
  "version": 2,
  "updatedAt": 123,
  "viewport": { "x": 0, "y": 0, "zoom": 1 },
  "nodes": [
    {
      "id": "n_xxx",
      "sessionId": "session-xxx",
      "title": "会话标题",
      "cwd": "<workspace>",
      "prompt": "...",
      "outputSpec": {},
      "defaultOutputPortId": "out_1",
      "inputPorts": [],
      "outputPorts": [],
      "x": 100,
      "y": 100
    }
  ],
  "edges": [
    {
      "id": "e_xxx",
      "from": { "nodeId": "n_a", "portId": "out_1" },
      "to": { "nodeId": "n_b", "portId": "in_1" },
      "mode": "hard",
      "order": 0,
      "instruction": ""
    }
  ]
}
```

## 二、迁移后

### Flow

```text
%DSH_HOME%/inter-session-flow/flows/default/1.0.0.json
```

```json
{
  "schemaVersion": 2,
  "flowId": "default",
  "version": "1.0.0",
  "title": "默认流程图",
  "description": "从 1.0.x graph.json 迁移",
  "nodes": [],
  "edges": [],
  "createdAt": "...",
  "updatedAt": "..."
}
```

### Binding

```text
%DSH_HOME%/inter-session-flow/bindings/default.json
```

```json
{
  "schemaVersion": 1,
  "flowId": "default",
  "flowVersion": "1.0.0",
  "nodes": {
    "n_xxx": {
      "sessionId": "session-xxx",
      "sessionTitle": "会话标题",
      "cwd": "<workspace>"
    }
  },
  "layoutOverrides": {},
  "updatedAt": "..."
}
```

### 备份

```text
%DSH_HOME%/inter-session-flow/backups/graph-<timestamp>.json
```

旧 `graph.json` 不删除。

## 三、节点映射

| 旧字段 | 新位置 | 说明 |
|---|---|---|
| `id` | FlowNode.nodeId | 保持不变 |
| `sessionId` | Binding.nodes[nodeId].sessionId | 不进入 Flow |
| `title` | Binding.nodes[nodeId].sessionTitle | 不进入 Flow |
| `cwd` | Binding.nodes[nodeId].cwd | 不进入 Flow |
| `prompt` | FlowNode.prompt | 保留 |
| `outputSpec` | FlowNode.outputSpec | 保留 |
| `defaultOutputPortId` | FlowNode.defaultOutputPortId | 保留 |
| `inputPorts` | FlowNode.inputPorts | 保留 |
| `outputPorts` | FlowNode.outputPorts | 保留 |
| `x` | FlowNode.layout.x | 保留 |
| `y` | FlowNode.layout.y | 保留 |

新增默认值：

```json
{
  "kind": "session",
  "role": "<title 或 工位>",
  "skills": [],
  "sessionPolicy": "existing"
}
```

`role` 规则：

```text
title 非空 → title
title 为空 → "工位 " + nodeId
```

## 四、边映射

| 旧字段 | 新位置 |
|---|---|
| `id` | Edge.id |
| `from` | Edge.from |
| `to` | Edge.to |
| `mode` | Edge.mode |
| `order` | Edge.order |
| `instruction` | Edge.instruction |

`mode` 校验：

```text
hard       保留
returnable 保留
其他       迁移为 hard，并写 warning
```

`order` 缺失：

```text
按数组顺序生成 0..n
```

## 五、viewport 映射

旧 `viewport` 是本机视图状态，不属于流程图定义。

写入：

```text
bindings/default.json.layoutOverrides.viewport
```

不进入 Flow。

## 六、运行迁移

旧运行记录：

```text
runs/*.json
```

v2.0：

- 保留原文件，不修改；
- 运行历史 API 兼容读取旧格式；
- 新运行写入 `runs/<runId>/run.json`；
- 旧 run 不强行转换。

## 七、迁移算法

```text
1. 读取 graph.json
2. 校验 version === 2
3. 生成备份 graph-<timestamp>.json
4. 构造 flow/default/1.0.0.json
5. 构造 bindings/default.json
6. 写临时文件
7. 原子 rename
8. 写 migration marker
```

Marker：

```json
{
  "migratedAt": "...",
  "fromVersion": 2,
  "toFlowVersion": "1.0.0",
  "backup": "backups/graph-....json"
}
```

重复执行时：

- marker 存在 → 跳过；
- 目标 flow/binding 已存在 → 不覆盖，生成 `.migrated` 副本或报错；
- 旧 graph 不存在 → 视为空。

## 八、兼容旧 API

迁移期：

```text
GET /api/inter-session-flow/graph
```

返回默认流程图的兼容投影：

```json
{
  "graph": {
    "version": 2,
    "nodes": [],
    "edges": []
  }
}
```

写入策略：

- v2.0 客户端不再写旧 API；
- 旧 API POST 可写默认流程图，但标记 legacy；
- 2.1 移除写兼容。

## 九、失败处理

迁移失败时：

```text
不覆盖旧 graph
不删除任何文件
写 migration-error.json
返回具体字段错误
```

UI 显示：

```text
迁移失败：<原因>
旧数据已备份：<path>
```

## 十、测试

必须覆盖：

1. 空 graph；
2. 单节点无边；
3. 多节点多边；
4. 旧 mode `twoway`；
5. 缺 order；
6. 缺 prompt/outputSpec/ports；
7. 重复 nodeId；
8. 重复 sessionId；
9. 非法端口；
10. 重复迁移幂等；
11. 迁移后导出包不含 sessionId；
12. 迁移后运行可启动。

## 十一、回滚

```text
停用 2.0.0
恢复 backups/graph-<timestamp>.json → graph.json
删除/重命名 flows/、bindings/、migration marker
重装 1.0.2
```

旧 runs 不受影响。
