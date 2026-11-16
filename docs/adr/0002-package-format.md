# ADR 0002：流程图包使用单文件 `.interflow.json`

- 状态：Accepted
- 日期：2026-11-16
- 决策人：lead
- 关联：`docs/DEVELOPMENT-PLAN-v2.md`

## 背景

流程图需要导出、导入、复制和后续分享。

候选格式：

1. `.zip`
2. 多文件目录
3. 单文件 JSON

当前插件只依赖 Node 内置模块；引入 zip 需要额外依赖或平台命令，增加安装与跨平台成本。

## 决策

v2.0 使用**单文件 JSON**：

```text
<flow-id>.interflow.json
```

扩展名 `.interflow.json`，MIME 可用 `application/json`。

## 包结构

```json
{
  "packageVersion": 2,
  "manifest": {
    "flowId": "sts-card-video",
    "flowVersion": "1.0.0",
    "title": "杀戮尖塔卡牌介绍视频流程图",
    "description": "...",
    "author": "...",
    "license": "TBD",
    "createdAt": "...",
    "pluginVersion": "2.0.0",
    "templateSpecVersion": 1,
    "skillLocks": [
      {
        "name": "sts-card-script",
        "version": "1.2.0",
        "contentHash": "sha256:...",
        "packageHash": "sha256:...",
        "archiveHash": null,
        "source": "github:owner/repo@<commit>",
        "license": "MIT",
        "licenseFile": {
          "path": "LICENSE",
          "sha256": "sha256:..."
        },
        "required": true,
        "distribution": "referenced",
        "dependencies": {
          "required": [],
          "optional": [],
          "checks": []
        }
      }
    ]
  },
  "flow": {
    "schemaVersion": 2,
    "nodes": [],
    "edges": [],
    "inputSchema": {},
    "outputSchema": {},
    "requirements": {}
  },
  "bindingsTemplate": {
    "schemaVersion": 1,
    "bindings": {
      "script_writer": null
    }
  },
  "examples": [],
  "tests": [],
  "readme": "..."
}
```

### 单一来源

- Skill 锁只放 `manifest.skillLocks[]`；
- 节点只放 `skillRefs: ["name@version"]`；
- 节点不重复存 hash/source/license；
- `flow` 只放运行结构，不再放 `flowId/version/title/description/examples/readme/createdAt`；
- `manifest` 是包元数据唯一来源。

## 不放入包的内容

```text
sessionId
会话标题
cwd
私人路径
密钥
运行历史
本机布局覆盖
```

## 为什么不做 zip

- 不需要新增依赖；
- 文本可 diff、可审查；
- 导入导出实现简单；
- 流程图包通常很小；
- Skill 只引用，不打包源码。

后续需要素材/二进制时，再引入：

```text
.interflow.zip
  package.json
  flow.json
  assets/
  skills/
```

v2.0 不做。

## 规范化与哈希

导入导出必须使用稳定序列化：

1. 对象 key 递归排序；
2. 数组保持顺序；
3. UTF-8、无 BOM；
4. 末尾单换行；
5. 对不含自身 hash 的内容计算 SHA-256。

哈希作用域必须写死，不能同名不同义：

```text
Skill 锁：
  contentHash   运行时 SkillDefinition 规范化哈希
  packageHash   Skill 分发包规范化文件清单哈希（不是 zip）
  archiveHash   可选：Skill zip/归档字节哈希

流程图包：
  flowHash      流程图包单文件 JSON 规范化哈希（不含 integrity 自身）
  archiveHash   可选：流程图包 zip/归档字节哈希
```

`skillLocks[].packageHash` 规则：

- 只对“应分发文件”；
- 相对 POSIX 路径；
- 按路径字节序排序；
- 每行 `<sha256>  <path>`；
- 排除 `MANIFEST`/`SHA256SUMS` 自身、缓存、pyc、临时文件；
- 对规范化清单再 SHA-256。

流程图包自身完整性（schema 必填；DRAFT 可为 null，import 预览允许 null，publish 必须非 null）：

```json
"integrity": {
  "algorithm": "sha256",
  "specVersion": 1,
  "flowHash": "sha256:...",
  "archiveHash": "sha256:..."
}
```

- `flowHash` 对流程图包规范化 JSON 计算，不含 `integrity` 自身；
- `archiveHash` 只表示流程图包 zip/归档字节；
- `licenseFile.path` 必须是包内相对路径，禁止绝对路径和 `..`；
- 两者都只保证完整性，不代表作者身份。

导入时：

- hash 不符：拒绝或强警告；
- 没有 hash：允许，但显示“未签名/未校验”；
- v2.0 的 hash 只保证完整性，不代表作者身份。

签名/公钥验证放后续版本。

## 模板变量

`manifest.templateSpecVersion = 1`。

只支持：

```text
{{run.field}}     流程图运行输入
{{input.field}}   当前边上游 payload 字段
{{input}}         整个 payload
```

不支持表达式、函数、数组索引。

渲染规则：

- 未知命名空间 → 阻断；
- 已知命名空间但字段缺失 → 空串 + 警告；
- 对象 → 规范化 JSON 字符串；
- 字符串 → 原样；
- null/undefined → 空串；
- 纯字符串替换，不执行表达式。

## targetField 路由语义

`outputSpec.targetField` 存在时：

```text
每条结果必须含该字段；
值必须等于该节点 outputPorts[].id 之一；
结果只投到 target 指定的端口；
不再应用 outputPorts[].policy（all/roundRobin）；
缺 target / 非法 target → preflight 或运行阻断；
targetField 必须同时出现在 outputSpec.fields 和 outputSchema 中；
结果数必须在 1..maxResults；
某端口 0 条 → 产生 empty-output-port 警告，不伪造结果。
```

`outputSpec.targetField` 不存在时：

```text
按 outputPorts[].policy 走。
```

测试：

```text
route-target        2 条结果 → out_1 / out_2 各 1 条
route-target-bad    缺 target / 非法 target → 阻断
route-target-empty  端口 0 条 → 警告，不伪造
```

## 版本与兼容

```text
packageVersion    包格式版本
flow.schemaVersion 流程图 schema 版本
pluginVersion     最低插件版本
flowVersion       流程图业务版本
```

不再重复：

```text
manifest.flowSchemaVersion  → 删除，使用 flow.schemaVersion
requirements.pluginVersion  → 删除，使用 manifest.pluginVersion
```

导入规则：

```text
packageVersion 不支持 → 拒绝
packageVersion 1 → 明确拒绝：v1 package not supported; migrate to v2
flow.schemaVersion 不支持 → 拒绝
pluginVersion 高于当前 → 拒绝
flowVersion 任意 semver → 接受
```

### fail closed

DRAFT 可以写 `TBD`/null，但 **preflight 必须阻断**：

```text
integrity.flowHash null → 阻断发布；import 只允许 DRAFT 预览
contentHash null 且 required → 阻断
同名同版本重复 lock → 阻断
bindings key 集合 != nodeId 集合 → 阻断
kind != session → 阻断（v2.0）
packageHash null 且 required Skill → 警告/可配置
source 缺失 → 警告
license 为 TBD / LicenseRef-* / 空 → 对外发布阻断
同名同版本 hash 不符 → required 阻断
未知 skillRef → 阻断
```

## 冲突策略

同一 `flowId + flowVersion` 已存在时：

```text
默认：保留现有，导入为副本
副本 id：<flowId>-2 / -3，标题追加 (2) / (3)
可选：替换（需确认）
不静默覆盖
```

默认新副本 id：

```text
<flowId>-copy
<flowId>-copy-2
```

## 安全限制

- 包大小上限：2 MB（v2.0）；
- 节点上限：200；
- 边上限：500；
- 文本字段上限：prompt 20 KB、edge instruction 10 KB、readme 64 KB；
- 禁止可执行字段；
- 禁止路径穿越字段；
- 导入不自动安装 Skill；
- 导入不自动运行；
- 导入后必须 preflight。

## 后果

好的方面：

- 无额外依赖；
- 易审查、易存储；
- 适合本地/小团队复制；
- 和后续 Git/市场包兼容。

代价：

- 不能携带大素材；
- 不能携带 Skill 源码；
- 多文件资源需要后续扩展。

## 验收

```text
导出后 JSON 可被独立解析
不含 sessionId
往返导入字段一致
hash 不符被拒绝
同名版本不静默覆盖
```
