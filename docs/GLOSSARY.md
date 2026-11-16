# 术语表：Flow / Edge


## 1. 对外与内部统一

| 术语 | 含义 |
|---|---|
| 流程图 / Flow | 一张可保存、导出、导入的跨会话流程图 |
| 节点 / Node | 一个工位 |
| 工位 / Workstation | 绑定会话、Skill、提示词、输出契约的节点 |
| 连线 / Edge | 节点之间的程序性传送带 |
| 绑定 / Binding | 本机 `nodeId → sessionId` 映射 |
| 流程图包 / Flow Package | `.interflow.json` |
| 流程图库 / Flow Library | 新建、打开、导入、导出流程图的入口 |

不要用“线”指整条流程图；  
不要用 `flow` 指一条连线。

## 2. 内部字段

| 内部字段 | 含义 |
|---|---|
| `Flow` | 流程图定义 |
| `flowId` | 流程图 id |
| `flowVersion` | 流程图版本 |
| `flowHash` | 流程图包定义哈希 |
| `flowContent` | 流程图运行结构 |
| `/flows` API | 流程图资源 |
| `flows/` 目录 | 流程图存储 |
| `Edge` | 连线 |

## 3. 旧名迁移

旧 M1 数据：

```text
flows/
flowId
flowVersion
flowHash
flowContent
```

已迁移为：

```text
flows/
flowId
flowVersion
flowHash
flowContent
```

旧 `flows/` 保留在备份中，代码不再读写。

## 4. 版本

```text
packageVersion: 2
flow.schemaVersion: 3
```

旧 v1 包（`flow` 字段）不再直接导入，后续补迁移器。

## 5. 一句话

> 对外叫流程图，内部叫 Flow；连线叫 Edge，不叫 flow。
