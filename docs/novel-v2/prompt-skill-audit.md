# Novel V2 Prompt / Skill 审计矩阵

本文是 `docs/novel-v2/chinese-fiction-craft-reference.md` 在当前代码中的落地索引。它描述当前三角色版本的实际调用关系、职责边界和修改后的验证方式，不是另一套运行时配置。

## 1. 维护原则

1. 参考文档提供文学职责和判断原则；Prompt 提供当前调用的任务契约；Skill 提供可复用的阶段能力；schema 和应用校验提供机读边界。
2. 活动不得自行 `listSkills()`、按字符串猜 Skill 或手工选择 Skill。每次模型调用由执行点解析当前环境 Skill，并把解析结果和实际注入结果记录到 manifest。
3. 开发/测试环境以 `skills/novel-v2/` 当前文件为准；生产环境以数据库 `skill_definitions` 为准。两种来源不互相 fallback。
4. Workflow 不锁定 Skill。进入新的 activity 或模型请求时重新读取当前来源；已提交给模型的请求不变，后续请求使用最新内容。
5. “安静章节可以成立”不等于“章节不需要承载”。判断重点是状态、理解、关系、资源、注意力、情绪或余波是否有可感知证据，而不是事件数量。

## 2. 六类流程矩阵

| 流程 | Prompt 构建器 | 执行点 | 当前直接/依赖 Skill | 主要职责 |
| --- | --- | --- | --- | --- |
| 项目架构 | `prompts/foundation.ts:buildFoundationPrompt` | `foundation.book-plan` / role `planner` | `foundation-planning`、`narrative-continuity`、`character-ensemble`、`plot-causality` | 读者承诺、主题问题、人物矛盾、世界压力、层级结构、线索方向、终局边界；不生成固定逐章表 |
| 架构审核 | `prompts/foundation-review.ts:buildFoundationReviewPrompt` | `foundation.book-plan` / role `foundation-reviewer` | `foundation-planning`、`narrative-continuity`、`character-ensemble`、`plot-causality`、`review-gate` | 审核 D1-D5、规划契约、层级因果、不确定性、下游可执行性和跨字段一致性 |
| 故事弧规划 | `prompts/story-arc.ts:buildStoryArcPrompt` | `arc.plan` | `foundation-planning`、`narrative-continuity`、`plot-causality` | 入口状态、欲望/压力、选择、代价、阶段变化、线索责任、章节状态和场景材料 |
| 故事弧审核 | `prompts/story-arc.ts:buildStoryArcReviewPrompt` | `arc.review` | `narrative-continuity`、`plot-causality`、`review-gate` | 检查状态连续、因果链、人物选择、世界压力、承诺证据、阶段边界、线索责任和事实权威 |
| 正文创作 | `prompts/chapter-draft.ts:buildChapterDraftPromptPackage` | `chapter.drafting` | `narrative-continuity`、`character-ensemble`、`prose-craft`、`reader-emotion` | 在当前 POV 和知识边界内，把蓝图转成动作、对白、感官、关系、情绪和后果；不回显蓝图或审核说明 |
| 正文内容审核 | `prompts/chapter-review.ts:buildChapterReviewPromptPackage` | 按角色分别使用 `chapter.review.structure`、`chapter.review.character`、`chapter.review.prose` | 结构：`narrative-continuity`、`plot-causality`、`review-gate`；人物：`narrative-continuity`、`character-ensemble`、`review-gate`；文风：`narrative-continuity`、`prose-craft`、`reader-emotion`、`review-gate` | 只报告有正文/冻结来源证据且影响当前功能或体验的问题，不用固定字数、钩子、反转、主题、感情线或幽默出现与否判定失败 |

`arc.revision`、`chapter.blueprint`、`chapter.revision` 是相邻的修订/执行层：它们必须继承对应审核的事实、因果和证据边界，不能自行发明一套质量标准。

## 3. 三角色覆盖

当前版本不是五个或六个独立 reviewer，而是三个角色合并覆盖五大维度：

| 角色 | 覆盖维度 | 必查证据 | 不应强制 |
| --- | --- | --- | --- |
| `structure-reviewer` | D1 世界观、D2 故事性 | 章节功能、目标/阻力/选择/代价/结果、规则与制度压力、时间线、知识边界、承诺证据 | 每章新事件、反转、设定复述或不可逆变化 |
| `character-reviewer` | D3 群像、D4 感情线 | 独立欲望、能动选择、声部、关系行为、边界、误解、让步、伤害、照料和共同后果 | 每章感情变化、关系结论或恋爱内容 |
| `prose-reviewer` | D2 体验承载、D5 幽默 | POV/叙述距离、具体细节、关键情绪/选择是否被摘要跳过、句式节奏、幽默来源和后果 | 固定句式、华丽程度、关键词、字数或章尾形式 |

`REVIEW_COVERAGE` 只做内部覆盖映射，模型输出仍以 evidence/excerpt 和最小 `revisionRanges` 为核心，不要求逐项填五大维度表格。

### 3.1 AI 味专项 Skill 覆盖

AI 退化由三个既有 Skill 按所属层处理，不新增独立 anti-slop execution point：

| Skill | 负责的共享机制 | drafting | review | revision |
| --- | --- | --- | --- | --- |
| `prose-craft@1.2.0` | 场景具象化、POV/叙述距离、段落同构、抽象表达过密、声部趋同和中文句法 | 把蓝图转成可经历的动作、感官、空间、对白和判断；修订窗口要求至少两类独立现场锚点，技术认知附着于已发生的感官或动作 | 只有出现正文损害时，引用证据识别摘要替代、同构、越界或声部问题 | 先修场景/视角/声部根因，再处理句法与词语；不能只换术语，必须补足可观察证据 |
| `reader-emotion@1.1.0` | 期待、理解、回报、关系温度和余波的机械化 | 用过程和后果形成读者动力，允许安静功能成立 | 检查体验变化是否有动作、信息差、关系反馈和余波证据 | 不用危险、反转、情绪宣言或固定章尾补偿体验缺口 |
| `plot-causality@1.1.0` | 章节级摘要式事件搬运、同构结构和因果过程缺失 | 仅在 `chapter.blueprint` 冻结入口压力、选择窗口、因果责任和退出状态，不冻结正文模板 | 仅在章节结构审核中引用跳过关键选择、无过程结论或重复推进造成的实际损害 | 在章节修订中补行动、阻力、判断和后果，不新增危机掩盖缺口 |

专项规则的运行时投影边界是章节执行层：`prose-craft` 和 `reader-emotion` 进入 `chapter.drafting`、`chapter.review.prose`、`chapter.revision`；`plot-causality` 的专项扩展只进入 `chapter.blueprint`、`chapter.review.structure`、`chapter.revision`。`foundation.book-plan` 与 `arc.*` 仍使用 `plot-causality` 的基础因果责任检查，但不注入反同构、摘要过程或正文现场化规则，避免把正文风格问题重复带入上游规划。

三个 Skill 只提供通用原则；词汇统计、检测器结果和单个修辞信号不能绕过 reviewer 的适用性判断，也不能在没有正文证据时创建 issue。

## 4. 修改 Skill 的流程

### 工作区开发/测试

```text
修改 skills/novel-v2/*.yaml
→ 下一次 Skill resolution 重新读取文件
→ 计算新的 contentFingerprint
→ compileStageContext 注入当前执行点内容
→ 模型调用直接使用本次编译产物及其 manifest
```

不需要重启服务，也不需要为正在运行的 Workflow 保存 Skill 快照。每次 activity 解析后由 compileStageContext 按 Skill 单独计量、注入并记录 injectedSkills；模型调用不再在编译后追加隐藏内容。稳定回归时固定工作区提交或测试 fixture，而不是依赖运行时锁定。

### 发布到数据库

```bash
pnpm novel:skills:validate
pnpm novel:skills:sync --target database
pnpm novel:skills:check --target database
```

`validate` 检查格式、执行点、依赖、冲突和 required 能力；`sync` 将工作区内容 upsert 到 `skill_definitions`；`check` 比对数据库当前内容和工作区待发布内容；`explain` 用于查看某一执行点和角色的实际解析闭包。

## 5. 修改后的验证重点

- `foundation.ts` 的必要字段必须与 `application/foundation-contract.ts` 的 required paths 一致。
- Story Arc Prompt 必须同时覆盖入口/退出状态、选择/代价、线索责任、承诺证据和安静章节边界。
- Draft Prompt 必须要求场景经验，不得把蓝图标签、心理结论或主题摘要直接写成正文。
- 三个章节 reviewer 必须分别拿到对应角色 Skill，并覆盖 D1-D5；不适用内容不能被制造成问题。
- required Skill 不能因预算被静默丢弃，workspace/database 模式不能跨源读取。
- 修改 YAML 后，新模型调用的 `contentFingerprint`、Prompt manifest 和实际 Skill 注入内容必须变化。
- 三个专项 Skill 的版本、执行点、依赖和 required priority 必须保持可解析；workspace 与 database source 之间不得自动 fallback。

推荐验证：

```bash
pnpm novel:skills:validate
pnpm novel:skills:explain -- --execution-point chapter.review.character --role character-reviewer
pnpm exec vitest run src/novel-v2/__tests__/prompts.test.ts src/novel-v2/__tests__/skill-runtime.test.ts src/novel-v2/__tests__/stage-context.test.ts --reporter=dot
pnpm lint
```
