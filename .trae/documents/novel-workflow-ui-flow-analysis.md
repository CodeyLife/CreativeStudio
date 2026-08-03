# 小说创作工作流与 Web 界面流程展示分析

> 视角: `gpt-taste` skill — AWWWARDS 级前端设计工程标准
> 范围: ymcp-creative-studio 当前的工作流定义 + Web 流程展示界面
> 输出: 现状分析 / 差距识别 / 改进方向(本 Plan 不含代码实施)

---

## 一、执行摘要 (TL;DR)

项目拥有一条**深度结构化的 11 阶段章节创作流水线**(context → blueprint → blueprint-approval → draft → review → revision → manuscript-approval → fact-extraction → fact-approval → commit → character-enrichment),并存在**双架构并存的 UI**(v1 `WorkflowCenter.tsx` 直查 IndexedDB / v2 `NovelV2Studio.tsx` 走 Temporal+Postgres)。

从 gpt-taste 视角审视,**当前 UI 的根本问题是"工程逻辑优先于设计语义"**:
- 流程展示停留在"横向步骤条 + 事件流时间线"的功能性堆砌,缺乏 AIDA 叙事节奏;
- 信息密度失衡: 11 个 stage 被等宽等高地平铺,丢失了"审批门禁 vs 执行阶段"的语义分层;
- 静态死板: 完全没有 GSAP ScrollTrigger 驱动的阶段推进动效,无法让用户"感受"工作流的呼吸;
- 元信息泛滥: 大量 `workflow.{status}` / `task.*` 事件码暴露给用户,违反 Meta-Label Ban;
- 双架构割裂: v1 有阶段轨但无设计感,v2 有事件流但无阶段视图,二者都没有给出"工作流全景"。

---

## 二、当前工作流现状分析

### 2.1 工作流定义(11 个 Stage)

源文件: [workflow-shared.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/workflow-shared.ts)

```
context → blueprint → [blueprint-approval] → draft → review → revision
                              ↓                  ↑          ↓
                            退回重生成 ──────────┘    [manuscript-approval]
                                                          ↓ 批准
                                            fact-extraction → [fact-approval]
                                                                    ↓ 批准
                                                                  commit
                                                                    ↓
                                                          character-enrichment
                                                                    ↓
                                                                  completed
```

**阶段语义分类**(UI 当前未区分):

| 类别 | Stages | 语义 |
|---|---|---|
| 上下文冻结 | context | 输入收敛 |
| 创作生成 | blueprint, draft | AI 主创 |
| 人工门禁 | blueprint-approval, manuscript-approval, fact-approval | Human Gate |
| 质量保障 | review, revision | 自审闭环(max 2 轮) |
| 知识沉淀 | fact-extraction, commit, character-enrichment | 长期记忆写入 |

### 2.2 调度机制

源文件: [workflow.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/workflow.ts)

- `advanceChapterWorkflow`: 单循环推进,`guard < 20` 防死循环;遇到 waiting-approval 跳出
- `STAGE_HANDLERS` / `APPROVAL_HANDLERS`: Map 注册制,`registerAllHandlers()` 集中装配
- `startChapterReviewWorkflow`: 半截启动入口(从 review 阶段切入,复用历史 blueprint artifact)
- 控制原语: `pauseWorkflow` / `resumeWorkflow` / `cancelWorkflow` / `failRun`

### 2.3 工作流产物契约

每个 stage 产出 `Artifact`(`kind` / `title` / `contentMarkdown` / `structuredData` / `fingerprint` / `skillRefs`),11 个 stage 累计产物种类: context-packet / blueprint / draft / quality-report / revision-window / manuscript-diff / fact-candidate / fact-batch / chapter-memory / character-enrichment / craft-rule-candidate。

---

## 三、当前 Web 流程展示界面分析

### 3.1 v1 `WorkflowCenter.tsx`(IndexedDB 直查)

源文件: [WorkflowCenter.tsx](file:///f:/GitHubProject/Ymcp/web/src/features/novel/WorkflowCenter.tsx)

**布局结构**:
1. Header: 标题 + 暂停/恢复/取消按钮
2. Status: Tag + 当前 stage 中文名 + "第 N 轮 · X 个产物"
3. **Workflow Rail**(核心可视化): 11 个 stage 横向步骤条,done 打勾 / active 高亮 / 未到显数字
4. Quality Report: weightedScore + 8 维 Progress 条 + issues 列表(blocker/major/warning 分类)
5. Human Gate: 三种审批门禁的差异化 UI(蓝图 Markdown / 逐段变更预览 / 事实列表一键采纳)
6. Artifact Ledger: 产物卡片列表,点击 Modal 查看完整内容
7. Failed: "从失败步骤重试"按钮

**gpt-taste 视角评分**:

| 维度 | 评分 | 评价 |
|---|---|---|
| Hero / Attention | 1/10 | 无 Hero,顶部直接是工程化标题 + 按钮组 |
| Bento / Interest | 3/10 | 信息密集但无 grid 设计,纯线性堆叠 |
| GSAP / Desire | 0/10 | 完全静态,无任何 ScrollTrigger / pinning |
| Footer / Action | 2/10 | 无 CTA,失败重试按钮是被动响应 |
| Meta-Label Ban | 4/10 | "CONTROLLED AGENT PIPELINE" 是典型工程化标签 |
| Hero Math | N/A | 无 Hero |
| Bento Density | 2/10 | 步骤条等宽平铺,无 dense grid |

### 3.2 v2 `NovelV2Studio.tsx`(Temporal + Postgres)

源文件: [NovelV2Studio.tsx](file:///f:/GitHubProject/Ymcp/web/src/pages/NovelV2Studio.tsx)

**studio Tab 三栏布局**:
- **左栏 章节轨**: 章节卡片列表(序号 + 标题 + status Tag + revision Tag)
- **中栏 焦点命令栏**: 提交 Intent 卡 / 当前章节卡 / 最近运行卡(workflowType 中文 + status 药丸 + temporalWorkflowId 短码)
- **右栏 观察者面板**: 运行状态 + 事件流(前 12 个事件,`describeEvent` 翻译) + 产物列表(kind 标签 + id 短码 + fingerprint 短码)

**展示层语义转译**: [presentation.tsx](file:///f:/GitHubProject/Ymcp/web/src/pages/novel-v2/presentation.tsx)
- `workflowTypeMeta`: novel-intent → "创作意图" 等
- `statusMeta`: 10 种 status 映射中文 + 图标 + 药丸 class
- `artifactKindMeta`: draft → "初稿" 等
- `describeEvent`: workflow/task/artifact 事件翻译为 EventDescription

**gpt-taste 视角评分**:

| 维度 | 评分 | 评价 |
|---|---|---|
| Hero / Attention | 1/10 | 三栏直接铺开,无 Hero 焦点 |
| Bento / Interest | 3/10 | 三栏等宽,无 dense grid,无视觉锚点 |
| GSAP / Desire | 0/10 | 完全静态,事件流是滚动列表 |
| Footer / Action | 1/10 | 无 CTA,只有"提交到 Temporal Runtime"工程按钮 |
| Meta-Label Ban | 2/10 | temporalWorkflowId 短码、fingerprint 短码暴露给用户 |
| Stage Visualization | 0/10 | **关键缺失**: 无 11 阶段进度可视化,只有线性事件流 |
| Quality Report | 0/10 | **关键缺失**: 无 8 维质量报告可视化 |
| Approval Gate | 2/10 | 只有通用 approve/reject,无差异化门禁 UI |

---

## 四、差距识别(对照 gpt-taste Iron Rules)

### 4.1 AIDA 结构缺失

| AIDA 阶段 | 当前状态 | gpt-taste 要求 |
|---|---|---|
| **Attention (Hero)** | 无 Hero,顶部直接是控制按钮 / 三栏布局 | 电影级宽屏 Hero,`max-w-6xl` H1,2-3 行内,2 个高对比 CTA |
| **Interest (Bento)** | 线性堆叠 / 等宽三栏 | `grid-flow-dense` 无空隙 Bento,3-5 张高度意图化卡片 |
| **Desire (GSAP)** | 完全静态 | ScrollTrigger pinning + 卡片堆叠 + 文字 scrubbing 揭示 |
| **Action (Footer)** | 无 CTA / 工程化按钮 | 大尺寸高对比 CTA + 干净 footer 链接 |

### 4.2 11 阶段流水线的可视化断层

**核心问题**: 11 个 stage 是项目的"灵魂骨架",但当前 UI 没有把它们当作"叙事章节"来设计。

- v1 的 Workflow Rail 是 11 个等宽小方块横向排列,**违反 Bento Density Rule**(无 dense grid,无视觉权重);
- v2 **完全没有**阶段级可视化,只有事件流时间线,用户无法一眼看出"现在跑到第几步、还剩几步";
- 阶段语义分类(上下文冻结 / 创作生成 / 人工门禁 / 质量保障 / 知识沉淀)在 UI 上**完全不可见**。

### 4.3 审批门禁体验割裂

- v1 有三种差异化门禁 UI(蓝图 Markdown / 逐段变更 / 事实列表),但**无 Hero 级视觉聚焦**;
- v2 只有通用 approve/reject 按钮,**丢失了门禁的"决策时刻"仪式感**;
- gpt-taste 要求: 审批门禁应该是"电影级章节转折点",用 GSAP Card Stacking 把待审内容堆叠推入视野。

### 4.4 质量报告展示缺失(v2)

- v1 有 8 维 Progress 条 + issues 分类(blocker/major/warning),但**无 scrubbing 揭示动效**;
- v2 **完全没有**质量报告可视化,review artifact 只在产物列表里显示 kind 标签;
- gpt-taste 要求: 8 维质量维度应该用 Inline Typography Images + scrubbing opacity 揭示,让用户"滚动阅读质量"。

### 4.5 事件流 vs 阶段流

- v2 的 `describeEvent` 把 outbox event 翻译为人类可读描述,但**事件是线性时序,不是阶段化聚合**;
- 用户看到的是"workflow.running → task.started → task.completed → artifact.created"的流水账,**无法理解"review 阶段共发生 X 个事件、产出 Y 个 artifact、耗时 Z"**;
- gpt-taste 要求: 事件应该按 stage 聚合为"Bento 卡片",每张卡片是"阶段的视觉摘要"。

### 4.6 产物列表过于简略(v2)

- v2 artifact list 只显示 kind 标签 + id 短码 + fingerprint 短码,**没有 title 或内容摘要**;
- 用户必须从 ID 反查或展开事件 payload 才能猜测内容;
- gpt-taste 要求: 每个产物应该是"Inline Typography Image + dense typography"的卡片,有标题、有摘要、有 hover 缩放。

### 4.7 Meta-Label 泛滥

违反 gpt-taste Meta-Label Ban 的实例:
- "CONTROLLED AGENT PIPELINE"(v1 Header)
- "temporalWorkflowId 短码"(v2 运行卡)
- "fingerprint 短码"(v2 产物列表)
- "workflow.running / task.started / artifact.created"(v2 事件流)
- "received / accepted / pending / running"(v2 status 药丸,虽然是中文但语义仍工程化)

### 4.8 学习闭环无可视化

AGENTS.md 强制契约: `learning.underlyingMechanism/affectedInputClass` 必填、`propose-improvement` 时必须构造 `createCraftRuleCandidate`。但 UI 完全没有展示:
- learning 状态(pending/completed/failed)
- craft rule candidate 流转(propose → evaluate → promote → rollback)
- skill 迭代历史

### 4.9 双架构割裂

- v1 与 v2 的导航路径、交互模式、视觉语言完全不同;
- 用户在 v1 看到的是"阶段轨 + 审批台",在 v2 看到的是"三栏 + 事件流",**无法形成统一心智模型**;
- AGENTS.md 明确"架构阶段不考虑兼容旧代码",意味着可以大胆设计统一的新架构。

---

## 五、改进方向(gpt-taste 视角)

> 以下为方向性建议,不含具体代码实施。每条建议都对应一个可独立交付的设计工作包。

### 5.1 设计工作包 A: 统一 AIDA 工作流展示页

**目标**: 用一个统一的 AIDA 页面替代当前 v1/v2 割裂的展示。

**AIDA 结构映射**:

| AIDA 阶段 | 对应工作流内容 | 设计语言 |
|---|---|---|
| Navigation | 项目切换 + 章节切换 | 浮动玻璃药丸 nav(floating glass pill) |
| Attention (Hero) | 当前章节 + 当前 stage + 当前 run 状态 | 电影级中心式 Hero,`max-w-6xl` H1 显示章节标题,下方 2 个 CTA(继续推进 / 暂停) |
| Interest (Bento) | 11 阶段流水线全景 | `grid-flow-dense` Bento,5 张语义分组卡片(上下文 / 创作 / 门禁 / 质量 / 沉淀) |
| Desire (GSAP) | 当前阶段的产物 + 事件 + 质量报告 | ScrollTrigger pinning 左侧阶段名,右侧滚动展示产物;Card Stacking 堆叠待审内容 |
| Action (Footer) | 学习闭环 + Craft Rule 候选 + 下一步操作 | 大尺寸 CTA "采纳并推进到下一阶段" + footer 链接到 Skill Center |

### 5.2 设计工作包 B: 11 阶段 Bento 全景

**目标**: 用 Bento Grid 替代横向步骤条,让 11 个 stage 成为"视觉主角"。

**Grid 数学验证**(grid-flow-dense,零空隙):

```
Grid: 12 columns × 6 rows
┌──────────────┬───────┬───────┐
│ context      │ blue- │ blue- │  Row 1-2  (col 1-6, 7-9, 10-12)
│ (6×2)        │ print │ print │           上下文冻结 + 创作生成
│              │ appr  │ draft │           (col 6+3+3 = 12, row 2)
├──────────────┴───┬───┴───────┤
│ review           │ revision  │  Row 3-4  (col 1-8, 9-12)
│ (8×2)            │ (4×2)     │           质量保障
├──────────┬───────┴───────────┤
│ manuscr  │ fact-extr │ fact- │  Row 4-5  (col 1-4, 5-8, 9-12)
│ appr     │           │ appr  │           人工门禁
│ (4×2)    │ (4×2)     │ (4×2) │
├──────────┴───────────┴───────┤
│ commit │ character-enrich    │  Row 6    (col 1-4, 5-12)
│ (4×1)  │ (8×1)               │           知识沉淀
└────────┴─────────────────────┘
```

**视觉权重**:
- 上下文冻结卡片: 最小尺寸,深色调,传递"输入收敛"的稳定感
- 创作生成卡片: 中等尺寸,暖色调 + 流光动效,传递"AI 主创"的活力
- 人工门禁卡片: 高对比边框 + 脉冲呼吸动效,传递"等待决策"的张力
- 质量保障卡片: 最大尺寸,展示 8 维质量条,传递"自审闭环"的严谨
- 知识沉淀卡片: 渐变色 + 向下流动动效,传递"长期记忆写入"的沉淀感

### 5.3 设计工作包 C: 审批门禁仪式化

**目标**: 把三种审批门禁(blueprint-approval / manuscript-approval / fact-approval)设计为"电影级章节转折点"。

**设计语言**:
- **Card Stacking(GSAP)**: 待审内容(blueprint / manuscript-diff / fact-candidate)从底部堆叠推入视野,逐张覆盖
- **Inline Typography Images**: 在待审标题中嵌入 pill 形小图(如蓝图预览缩略图、段落 diff 缩略图)
- **决策按钮**: 不是普通 approve/reject,而是"采纳并继续 / 退回重写 / 部分采纳"三选一,每个按钮配 hover 缩放 + 颜色反馈
- **质量门控可视化**: 在 manuscript-approval 时,把 8 维质量分数悬浮显示为半透明背景层

### 5.4 设计工作包 D: 质量报告 scrubbing 揭示

**目标**: 让用户"滚动阅读质量",而不是看一堆静态 Progress 条。

**设计语言**:
- 8 个质量维度(style/character/continuity/plot/reader + 3 个补充维度)横向排列为"质量光谱"
- ScrollTrigger scrubbing: 每个维度的 opacity 从 0.1 → 1.0 依次激活,用户滚动时"逐维点亮"
- issues 列表用 Horizontal Accordion: 默认折叠,hover 展开显示 excerpt / rule / suggestion / rewriteExample
- weightedScore 用大尺寸数字 + 计数动画(从 0 滚动到最终分)

### 5.5 设计工作包 E: 事件流阶段化聚合

**目标**: 把线性事件流聚合为"阶段卡片",让用户理解阶段而非事件。

**设计语言**:
- 按 stage 聚合事件: "review 阶段 · 7 个事件 · 2 个产物 · 耗时 3m 12s"
- 每个阶段卡片用 Horizontal Accordion 展开内部事件
- 事件描述彻底去除工程码(workflow.running / task.started),改为自然语言("审核任务已启动" / "风格审校完成")
- 阶段卡片用 ScrollTrigger pinning: 左侧 pin 阶段名,右侧滚动事件细节

### 5.6 设计工作包 F: 学习闭环可视化

**目标**: 把 AGENTS.md 强制的 learning 闭环从"后端契约"变为"用户可见的演进轨迹"。

**设计语言**:
- learning 状态(pending/completed/failed)作为"阶段卡片"的右下角徽标
- craft rule candidate 流转(propose → evaluate → promote → rollback)用 Infinite Marquee 横向滚动展示
- skill 迭代历史用 Timeline 组件,每次迭代显示 learning.underlyingMechanism / affectedInputClass
- propose-improvement 触发时,UI 用 GSAP 高亮"经验沉淀"路径

### 5.7 设计工作包 G: 字体与配色系统

**Typography Stack**(gpt-taste 强制: 禁用 Inter):
- Hero H1: Cabinet Grotesk(展示型,宽屏气派)
- 正文: Satoshi(可读性 + 现代感)
- 代码 / 工程值: Geist Mono(等宽,但仅用于真实工程数据)

**配色**:
- 主背景: 深炭黑 #0a0a0a + 径向暗光晕
- 卡片: 玻璃态 backdrop-blur + 半透明白边
- 强调色: 暖橙 #ff6b35(创作生成) / 冷青 #4ecdc4(质量审校) / 金 #ffd93d(人工门禁)
- 文本: 主 #fafafa / 次 #a3a3a3 / 弱 #525252

### 5.8 设计工作包 H: 横向滚动防护

**强制**: 整页包裹 `<main className="overflow-x-hidden w-full max-w-full">`,防止 GSAP 动画导致横向滚动条。

---

## 六、假设与决策

### 6.1 关键假设

1. **任务范围**: 本 Plan 仅产出分析与方向性建议,**不含代码实施**。如需实施,需用户确认后进入执行阶段。
2. **架构阶段原则**: 遵循 AGENTS.md "不考虑兼容旧代码",允许大胆设计统一新架构,无需迁就 v1/v2 现有实现。
3. **gpt-taste 标准**: 所有改进建议严格对照 gpt-taste Iron Rules(AIDA / Hero Math / Bento Density / GSAP / Meta-Label Ban / Label Sweep)。
4. **不引入 Emojis**: 遵循 gpt-taste "DO NOT USE EMOJIS" 规则,所有设计描述使用专业术语。

### 6.2 待用户确认的决策点

1. **是否进入实施阶段**: 本 Plan 是分析型 Plan,若用户希望立即实施某个工作包(如 5.1 统一 AIDA 页面),需在用户批准后另起实施 Plan。
2. **v1/v2 取舍**: 是否同意"废弃 v1 WorkflowCenter,统一到 v2 Temporal 架构 + 全新 AIDA UI"?还是保留 v1 作为离线兜底?
3. **GSAP 依赖**: 当前 package.json 已有 `motion`(Framer Motion 后继),但 gpt-taste 强制要求 `@gsap/react` + `ScrollTrigger`。是否同意引入 GSAP 作为额外依赖?
4. **字体加载**: Cabinet Grotesk / Satoshi / Geist 需要从 Fontshare 或自托管加载,是否同意引入?

---

## 七、验证步骤(分析型 Plan 的验证)

由于本 Plan 是分析型而非实施型,验证步骤为"分析质量验证":

1. **代码引用准确性**: 所有文件路径与代码片段均来自 Phase 1 探索的真实读取,可通过点击 file:/// 链接验证。
2. **gpt-taste 标准对照**: 每条差距识别都对应 gpt-taste 的具体 Iron Rule(参见各章节对照表)。
3. **工作流契约一致性**: 11 阶段定义、stage handler 列表、`startChapterReviewWorkflow` 契约均与 AGENTS.md 强制契约一致。
4. **改进方向可执行性**: 每个设计工作包(A-H)都是独立可交付的,可单独评估优先级与依赖关系。

---

## 八、附录: 关键文件路径速查

| 用途 | 路径 |
|---|---|
| 工作流定义(11 stages) | [workflow-shared.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/workflow-shared.ts) |
| 工作流调度器 | [workflow.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/workflow.ts) |
| StageHandler 接口 | [workflow-stages.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/workflow-stages.ts) |
| Handler 注册入口 | [workflow-stages/index.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/workflow-stages/index.ts) |
| v1 工作流中心 UI | [WorkflowCenter.tsx](file:///f:/GitHubProject/Ymcp/web/src/features/novel/WorkflowCenter.tsx) |
| v2 工作室主页 | [NovelV2Studio.tsx](file:///f:/GitHubProject/Ymcp/web/src/pages/NovelV2Studio.tsx) |
| v2 展示层转译 | [presentation.tsx](file:///f:/GitHubProject/Ymcp/web/src/pages/novel-v2/presentation.tsx) |
| v2 Temporal workflow | [workflows.ts](file:///f:/GitHubProject/Ymcp/web/src/novel-v2/temporal/workflows.ts) |
| MCP 工具定义 | [tool-definitions.ts](file:///f:/GitHubProject/Ymcp/web/src/novel-v2/mcp/tool-definitions.ts) |
| MCP UI 面板 | [McpToolGatewayPanel.tsx](file:///f:/GitHubProject/Ymcp/web/src/pages/novel-v2/McpToolGatewayPanel.tsx) |
| 项目 Agent 约束 | [AGENTS.md](file:///f:/GitHubProject/Ymcp/web/AGENTS.md) |
