# ADR 0003：Skill 引用、版本锁与分发包治理

- 状态：Accepted（v2.0 只做 referenced）
- 日期：2026-11-16
- 决策人：lead
- 评审：设计评审已通过
- 关联：`docs/spikes/skill-api.md`、17 的《Skill 打包与版本治理》

## 背景

流程图节点需要声明“这个工位用了什么 Skill”。

DSH `skills` 服务提供：

```ts
list(options): Promise<SkillSummary[]>
snapshot(options): Promise<SkillCatalogSnapshot>
get(name, options): Promise<SkillDefinition | undefined>
```

`SkillSummary` 字段：

```ts
path?: string
name: string
description: string
whenToUse?: string
invocation: { modelInvocable: boolean; userInvocable: boolean }
source: string
provider: string
resourceBase?: SkillResourceBase
```

`SkillDefinition` 增加：

```ts
content: string
metadata?: Record<string, unknown>
```

关键结论：

> DSH Skill API 没有一等 `version`，也没有 `contentHash`、`license`、依赖或权限字段。

## 17 的评审结论

17 的判断：

> M0 方向对，但 `contentHash` 不能单独当锁。

至少还要补：

1. hash 的规范化规则；
2. 来源 source；
3. 许可证 license；
4. 依赖/权限；
5. 同名多版本与锁文件解析策略。

本 ADR 采纳这个修订。

## 决策

### 1. 流程图中的 Skill 锁

每个节点可以有：

```json
{
  "name": "sts-card-script",
  "version": "1.2.0",
  "contentHash": "sha256:...",
  "packageHash": "sha256:...",
  "archiveHash": "sha256:...",
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
```

字段含义：

| 字段 | 含义 |
|---|---|
| `name` | DSH kebab-case 技能名 |
| `version` | 人类可读 SemVer，来自 Skill 包 manifest |
| `contentHash` | 运行时加载的 SkillDefinition 规范化哈希 |
| `packageHash` | Skill 分发包的**规范化文件清单**哈希（不是 zip 哈希） |
| `archiveHash` | 可选：zip/归档文件的哈希，和 packageHash 分开命名 |
| `source` | 不可变来源：repo + tag/commit；不要只写 main |
| `license` | SPDX 或明确标识 |
| `licenseFile` | LICENSE 路径 + 文件哈希 |
| `required` | 缺失是否阻断 |
| `distribution` | v2.0 固定 `referenced` |
| `dependencies` | required / optional / checks |

`version` 只展示，不作为严格锁；`contentHash`/`packageHash` 才是锁。

### 2. 内容哈希必须规范化

#### 运行时 contentHash

对 `SkillDefinition` 的以下字段做规范化 JSON：

```json
{
  "name": "...",
  "description": "...",
  "whenToUse": "...",
  "metadata": {},
  "content": "..."
}
```

规则：

```text
对象 key 递归排序
数组保持顺序
UTF-8、无 BOM
固定换行
SHA-256
```

用途：检测安装后的 Skill body 漂移。

#### 分发包 packageHash

按 17 的打包规范：

```text
1. 只对“应分发文件”计算
2. 相对 POSIX 路径
3. 按路径字节序排序
4. 每行 <sha256>  <path>
5. 排除 MANIFEST/SHA256SUMS 自身、缓存、pyc、临时文件
6. 对规范化清单再 SHA-256
```

`packageHash` 是**规范化文件清单的哈希**，不是 zip 文件哈希。

这样换压缩工具、换时间戳不会漂；`SHA256SUMS.txt` 仍可逐文件复核。

如果同时有 zip/归档哈希，单独命名：

```text
archiveHash  zip/归档文件哈希
packageHash  规范化文件清单哈希
```

两者不能混用。

同时保留文件级 `SHA256SUMS.txt`。

用途：检测下载/解压后的包是否完整，并区分同名不同版本。

#### 两层哈希的关系

```text
packageHash  证明“这个 Skill 包是完整的”
contentHash  证明“运行时装进来的内容是同一份”
```

两者都有最好；只有 contentHash 时，标记 `package-unverified`。

### 3. 来源与许可证

流程图锁必须能回答：

```text
Skill 从哪来？
谁授权？
能不能随流程图分发？
```

规则：

- `source` 必须是不可变引用：`repo + tag/commit`；
  - 不要只写 `main` / `latest`；
  - 本地包写 `local:<path>@<packageHash>`；
  - 内置写 `bundled:<name>@<version>`；
- `license` 写 SPDX 或明确标识；
- `licenseFile` 记录 LICENSE 相对路径 + 文件 sha256；
- 内部预览缺 `license` 可警告；
- 对外发布缺 `license` 必须阻断，不能静默发布；
- `distribution: referenced` 只引用，不复制 Skill 内容，通常不触发再分发；
- 打包进流程图属于再分发，必须保留 LICENSE/NOTICE，许可不允许就不能 vendor；
- 不能把“引用了 MIT Skill”当成“整条流程图变成 MIT”。

v2.0 不支持 vendored；`distribution` 只允许 `referenced`。

### 4. 同名多版本

DSH 的 `ctx.skills.list()` 以 `name` 为键，同一层只能有一个 active 同名 Skill。

因此：

- 流程图锁存 `name + version + contentHash + source + license`；
- 不在 DSH 内静默覆盖同名 Skill；
- 如果目标会话已安装同名 Skill 但 hash 不符：
  - 必需 Skill → 阻断；
  - 可选 Skill → 警告；
  - 提示用户替换/切换版本；
- 旧版本要归档，保证可回滚；
- 后续本地 Skill 库可以使用：

```text
skills/<name>/<version>/
store/<contentHash>/
```

但 v2.0 不实现 Skill 存储/安装器。

### 5. 解析以目标会话为准

同一 Skill 名在不同 preset/scope 可能有不同实现。

解析顺序：

```text
目标会话 preset 作用域的 skills 服务
→ 全局 skills 服务
→ sessionSkillCatalog 仅做存在性/可见性检查
→ 失败
```

实现方向：

```ts
const agent = ctx.agents.get(sessionId)
const scoped = ctx.agentPresets.serviceFor(agent, 'skills')
const service = scoped || ctx.skills
const skill = await service.get(name, { cwd })
```

具体是否可用，M1 用真实会话验证。

### 6. preflight 规则

```text
必需 Skill 缺失 → 阻断
contentHash 不符 → 阻断
packageHash 不符 → 阻断
同名但版本/hash 不符 → 阻断或警告
license 缺失 → 内部预览警告；对外发布阻断
source 缺失 → 警告
依赖未声明 → 警告
可选 Skill 缺失 → 警告
无 contentHash → 警告“未锁定”
目标会话无法解析 → 阻断或降级警告
```

### 7. 提示词注入顺序

v2.0 不依赖目标会话是否已经把 Skill 放进模型目录。

流程：

```text
解析 Skill
→ 读取 content
→ 注入提示词
→ 记录 name/provider/source/version/contentHash/packageHash/loadedAt
```

固定层级：

```text
1. 工位角色
2. Skill 内容
3. 节点提示词
4. 边指令
5. 输出契约
6. 上游输入
```

输出契约最后，格式优先级最高。

Skill 与输出契约冲突时：

- 输出契约优先；
- 记录 `prompt-conflict-warning`；
- 不静默忽略。

### 8. Skill 包最小结构（摘自 17）

```text
<name>/
├─ SKILL.md
├─ README.md
├─ LICENSE
├─ SOURCE.md
└─ MANIFEST.md / SHA256SUMS.txt
```

按需：

```text
references/
scripts/
examples/
assets/
tests/
INSTALL.md
CHANGELOG.md
THIRD_PARTY_NOTICES.md
```

不进入包：

```text
游戏本体
exe/dll
venv/node_modules
缓存
密钥
真实存档
私人截图
```

### 9. 依赖与权限

建议 Skill 包提供机器可读清单（`skill.json` 或 `DEPENDENCIES.md`）：

```yaml
dependencies:
  required:
    - kind: tool
      name: web_search
    - kind: runtime
      name: python
      version: ">=3.9"
  optional:
    - kind: tool
      name: web_fetch
      degrade: "只使用已有资料"
  checks:
    - kind: command
      name: python
      command: "python --version"
    - kind: port
      name: farmer-bridge
      host: 127.0.0.1
      port: 15800
    - kind: env
      name: API_TOKEN
      required: false
permissions:
  network: true
  filesystem: read-write
  process: true
```

v2.0 只读取并展示这些字段，不自动安装/启动外部服务；preflight 只执行声明的安全 `checks`，不执行 Skill 脚本。

### 10. 官方节点边界

确定性内置：

```text
结构校验
hash 校验
schema 校验
文件/路径检查
汇总/拼接/格式化
条件路由/重试/超时
权限/依赖检查
审计日志
```

必须绑定 AI 会话：

```text
内容生成/改写/总结
语义判断
开放规划
自然语言路由
```

人工确认：

```text
写文件/发布/花钱/改游戏内存/不可逆操作
```

监管节点：

```text
规则引擎做确定性检查
AI 只解释/建议
高风险强制人工
```

v2.0 只做 session 工位；官方 builtin 节点后续实现。

## 后果

好的方面：

- 流程图锁能表达来源/许可/哈希/依赖；
- 不依赖不存在的 version 字段；
- 同名版本冲突可被发现；
- 可解释“为什么这条流程图在这台机器跑不了”。

代价：

- 需要 Skill 包 manifest；
- 需要两层 hash；
- preflight 复杂度上升；
- DSH 全局只能有一个同名 active，版本共存需要本地库（v2.1+）。

## 验收

```text
节点用 `skillRefs: ["name@version"]` 引用锁；
manifest 的 `skillLocks[]` 是唯一锁表；
缺 Skill 阻断
hash 不符阻断
license/source 缺失：内部预览警告；对外发布 license 阻断
运行快照记录完整锁
导出包不包含 Skill 源码
```

## 待验证

1. `agentPresets.serviceFor(agent,'skills')` 是否可用；
2. 冷会话能否解析 preset Skill；
3. `SkillDefinition.content` 是否包含 frontmatter；
4. 全局与目标会话的 Skill 是否同名不同实现；
5. contentHash 是否稳定。
