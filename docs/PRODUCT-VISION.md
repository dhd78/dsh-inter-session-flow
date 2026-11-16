# 产品方向：数字流程图与流程图链路市场

> 记录时间：2026-11-15  
> 状态：方向讨论，未进入实现  
> 关联：`dsh-inter-session-flow`

## 一、最终形态

这个插件不应只停在“会话间流程图”。

最终目标是成为一个**数字流程图搭建工具**：

```text
会话（工位）
+ Skill（工艺）
+ 提示词（作业指导）
+ 流程图（工序）
+ 输入/输出契约（物料规格）
= 可复制、可交付、可复用的流程图
```

一条流程图可以被：

- 保存；
- 版本化；
- 导出；
- 导入；
- 绑定本机会话；
- 运行；
- 复制；
- 分享/交易。

## 二、核心概念

| 概念 | 含义 |
|---|---|
| 流程图 / Flow | 一张完整的跨会话工作流 |
| 工位 / Node | 一个绑定了会话、Skill、提示词和输出契约的角色 |
| 工序 / Edge | 工位之间的交接关系和传递规则 |
| 工艺 / Skill | 工位使用的可复用能力包 |
| 物料 / Input | 流程图启动输入和中间产物 |
| 成品 / Artifact | 最终输出和阶段性证据 |
| 绑定 / Binding | 某条流程图在本机的“工位→会话”映射 |
| 流程图包 / Flow Package | 可导出的流程图资产 |

## 三、为什么这个方向成立

普通流程图只表达“步骤”，不表达“谁来执行、用什么能力、交付什么”。

数字流程图把以下东西一起封装：

- 角色分工；
- Skill；
- 提示词；
- 交接格式；
- 输入输出；
- 质量校验；
- 运行证据；
- 版本与依赖。

这比“分享一张图”更有价值，因为别人拿到后可以**重新组装并生产**，而不是只看懂。

## 四、举例：杀戮尖塔卡牌介绍视频流程图

角色工位可以包括：

```text
选题/分任务
卡牌资料研究
文稿撰写
事实与规则校验
分镜/动画脚本
动画制作
配音
剪辑/合成
终审
```

每个工位：

- 绑定一个会话；
- 加载一个 Skill；
- 设置节点提示词；
- 定义输入口和输出口；
- 定义 JSON/文本输出契约。

连接完成后：

```text
主题输入
→ 分任务
→ 资料/文稿/校验
→ 分镜/动画/配音
→ 合成
→ 成品视频
```

这条流程图可以打包成：

```text
flow.json
skills/
prompts/
schemas/
examples/
manifest.json
README.md
LICENSE
```

其他人导入后：

1. 安装依赖 Skill；
2. 为每个工位绑定自己的会话；
3. 运行 preflight；
4. 输入主题；
5. 生产视频。

## 五、当前插件离这个目标差什么

### 1. 节点仍然硬绑定会话

现在节点带的是：

```text
sessionId / title / cwd
```

这不可移植。

需要拆成：

```text
Flow Node Template
  role
  skillRefs
  prompt
  outputSpec
  ports
  requirements

Local Binding
  nodeId -> sessionId
```

流程图包只带模板，不带本机会话 id。

### 2. 没有流程图包格式

需要定义：

```text
manifest.json
flow.json
skills/
schemas/
examples/
tests/
README.md
LICENSE
```

### 3. 没有 Skill 感知

节点需要声明：

- 使用哪些 Skill；
- Skill 版本；
- 需要的工具/权限；
- 输入输出 schema；
- 示例。

### 4. 没有可复现性

已有会话带着历史上下文，同一条流程图换一个人跑，结果可能完全不同。

需要支持：

- 绑定已有会话；
- 新建干净工位会话；
- 清空/隔离上下文；
- 固定 Skill 版本；
- 保存运行快照。

### 5. 没有 durable run

当前 run 只在 Host 内存中，DSH 重启会丢。

需要：

- append-only 事件；
- run snapshot；
- 断点恢复；
- 单节点重试；
- 已完成结果缓存；
- 运行证据。

### 6. 没有市场治理

市场需要：

- 包签名/哈希；
- 许可证；
- 版本兼容；
- 权限声明；
- 安全审计；
- 质量评分；
- 运行成本；
- 退款/下架/更新策略。

## 六、借鉴 dsh_workflow 的地方

重点不是学它的多 Agent 调度，而是学它的工程纪律：

```text
preflight
manifest
versioned capsule
immutable run snapshot
append-only events
resume/effect cache
artifact/evidence
approval/capability
clean-profile tests
```

这些会直接决定流程图市场是否可信。

## 七、市场单位

不要卖“流程图文件”。

要卖：

> **一条经过验证、可运行、可复现的流程图。**

流程图包至少应包含：

```text
manifest
flow graph
skill dependencies
input/output schema
example input
expected artifacts
preflight checks
smoke test
license
changelog
```

买家购买的是：

- 生产能力；
- 质量证据；
- 可维护版本；
- 可替换的 Skill/工位；
- 持续更新。

## 八、市场风险

1. 导入的 Skill 可能含恶意脚本；
2. 流程图可能把私人数据发到错误会话；
3. 提示词注入可能改变工位行为；
4. 第三方 Skill 许可证冲突；
5. 同一条流程图在不同 DSH/模型版本上结果漂移；
6. 卖家可以“卖图”，但买家跑不起来；
7. 低质量流程图会迅速消耗市场信任。

因此市场必须从一开始就有：

- 签名/哈希；
- 权限清单；
- 兼容版本；
- 安装 preflight；
- 示例输入；
- 质量分级；
- 许可证字段；
- 举报/下架机制。

## 九、建议路线

### Phase 0：把“流程图定义”和“本机会话”拆开

- Node Template：role / skill / prompt / outputSpec / ports；
- Local Binding：nodeId → sessionId；
- 导出不带 sessionId。

### Phase 1：流程图包 + 导入导出 + preflight

- `manifest.json`
- `flow.json`
- `bindings.template.json`
- 导入向导
- 依赖检查

### Phase 2：durable run + 恢复 + 证据

- run journal
- snapshot
- 单节点重试
- 断点恢复
- artifact 目录

### Phase 3：Skill 工位 + 干净会话

- Skill 引用和版本；
- 新建工位会话；
- 上下文隔离；
- Skill 注入顺序。

### Phase 4：做出一条真实流程图

建议第一条就是“杀戮尖塔卡牌介绍视频”：

- 端到端跑通；
- 记录耗时/成本；
- 产出示例；
- 打包；
- 让第二个人导入并复跑。

### Phase 5：本地流程图库 / 市场试点

- 先做私有库/团队库；
- 再做公开市场；
- 先审核上架，不开放任意上传；
- 先免费/内测，再考虑交易。

## 十、关键判断

> 这不是“流程图插件加一个市场”，而是“流程图运行时 + 流程图包标准 + 技能供应链 + 市场治理”。

如果只做画布，容易被替代；  
如果做成了**可复制、可验证、可恢复的流程图资产**，才有长期价值。

## 十一、命名备选

- 会话间流程（当前）
- 数字流程图 / Digital Flow
- 工位 / Flow Station
- 流程图包 / Flow Package
- 流程图市场 / Flow Market
- FlowFlow / 工坊
