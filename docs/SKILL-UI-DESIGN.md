# Skill 自动检测与选择 UI 设计

- 日期：2026-11-16
- 状态：设计稿，M4 实现
- 关联：M1 flow schema 3 / Skill packageHash

## 一、结论

这个方向对：

```text
编辑时自动检测已有 Skill
节点卡片下直接选择
导入时检测缺失
节点冒 ! 提示
```

但建议加三条约束：

1. **检测到不等于自动挂上**：只展示可选项，选择由用户确认；
2. **导入允许带警告进入**，不直接拒绝；缺 Skill 的节点显示 `!`，运行/发布前再阻断；
3. **区分 missing / mismatch / version**，不要都用同一个感叹号。

## 二、Skill 目录

### 数据来源

```text
ctx.skills.list()                         全局 Skill
sessionSkillCatalog.list({ sessionId })   某个会话可用的 Skill
agentPresets.serviceFor(agent,'skills')   可选，按 preset 范围
```

节点已绑定会话时：

```text
优先展示该会话可用的 Skill
再展示全局 Skill
标出 scope: session / global
```

节点未绑定时：

```text
展示全局 Skill
```

### 展示字段

```text
name
description / whenToUse
provider
source
version（Skill 包有 manifest 才有；否则 unknown）
scope（global / session）
contentHash / packageHash（编辑时不展示长 hash，preflight 用）
```

### 名称歧义

DSH Skill 可能同名不同 provider。建议内部身份用：

```text
provider/name@version      有 provider 时
name@version               只有 name 时
```

UI 显示 `name`，详情里显示 provider/source。

## 三、节点卡片

节点卡片底部显示已选 Skill：

```text
[research] [writer] [+ Skill]
```

- 没有 Skill：`+ Skill`；
- 缺失：红色 chip `! sts-research`；
- 不匹配：黄色 chip `! hash`;
- 点击 chip 打开节点属性里的 Skill 区；
- 不自动把检测到的所有 Skill 都塞进节点。

## 四、节点属性面板

新增「Skills」区：

```text
已选
  [research] ×
  [writer] ×

可用 Skills（已检测）        [刷新]
  [x] research   session
  [ ] writer     global
  [ ] checker    session

搜索...
```

行为：

- 打开节点时自动加载；
- 搜索 name/description；
- 勾选/取消；
- 显示 scope/provider；
- 会话绑定改变后重新检测；
- 不自动移除已选 ref，只标记 unresolved；
- 刷新不会丢选择。

## 五、导入流程

导入包里有：

```text
nodes[].skillRefs[]
manifest.skillLocks[]
```

导入时：

```text
对每个 skillRef：
  1. 本地是否存在 name/provider/version
  2. contentHash 是否匹配
  3. packageHash 是否匹配
  4. required 是否为 true
```

结果：

| 情况 | 节点提示 | preflight | 运行/发布 |
|---|---|---|---|
| 找到且 hash 匹配 | 正常 | pass | 允许 |
| 找到但 hash 不匹配 | 黄色 `!` | error（required） | 阻断 |
| 本地没有 | 红色 `!` | error（required） | 阻断 |
| optional 缺失 | 黄色 `!` | warning | 允许但提示 |
| 版本未知 | 灰色 `?` | warning | 由 hash 决定 |

导入策略：

```text
允许导入带警告的流程图
不自动安装 Skill
不静默删除 skillRefs
节点卡片直接显示 !
preflight 列出缺失/不匹配
用户可移除引用或安装 Skill 后重新检测
```

这与“导入后先看见流程图，再修复依赖”一致，比整包拒绝更可用。

## 六、数据保存

当前：

```text
flow.nodes[].skillRefs[]        已存在
package.manifest.skillLocks[]   已存在
```

还需要：

```text
本地 flow 保存 skillLocks 副本
```

建议 M4 在 flow 根上加可选 `skillLocks`：

```json
{
  "schemaVersion": 4,
  "flowId": "...",
  "skillLocks": [ ... ],
  "nodes": [ ... ]
}
```

理由：

- 导入后才能显示 missing/mismatch；
- 不用把锁表塞进 `flowContent`，避免运行快照混入包元数据；
- 需要升 `flow.schemaVersion`，M4 做，不在 M1 临时改。

## 七、检测与哈希

编辑时：

```text
list skills → 显示可选项
选择 → flow.nodes[].skillRefs
```

导出时：

```text
skillRefs → 解析本地 Skill
计算 contentHash / packageHash
写 manifest.skillLocks
缺 Skill → 导出 draft 可带 warning；publish 阻断
```

导入时：

```text
读 manifest.skillLocks
对本地目录重新计算 hash
不信任包里的 hash
```

## 八、测试

必须覆盖：

```text
skill catalog 检测
节点选择/取消
会话绑定变化后 unresolved
导入 missing skill → 节点 !
导入 hash mismatch → 节点 !
required missing → preflight error
optional missing → warning
不自动安装
不静默删除 skillRefs
```

## 九、里程碑

```text
M4：catalog API + 节点 Skill 选择 + resolver + 导入警告
M6：真实多工位流程图，至少 2 个 Skill
M7：00 全面测试、发布硬化
```


## 十、建议

建议做成：

```text
编辑时“可检测、可搜索、可多选”
导入时“先进入、缺什么标什么”
运行前“必需缺失才阻断”
```

不建议：

```text
自动挂载所有 Skill
缺 Skill 直接拒绝导入
同名 Skill 静默取第一个
```
