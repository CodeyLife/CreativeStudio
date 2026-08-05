# 《万法归渊》全书架构审计

> 审计时间：2026-08-04  
> 项目：`novel-create-wanfa-20260801`  
> 入口：`GET /v2/projects/:projectId/architecture/health`  
> 范围：Foundation、故事弧、批次和跨阶段引用；不把正文审校分数当作全书架构结论。

## 1. 结论

初始架构的问题不是“章节写得不够好”，而是全书设计没有把可执行的阶段责任传递给后续生成层。原 `architecture` 主要只有六卷的名称、主题、功能和章节数；原人物档案缺少限制与独立行动；世界规则是纯文本列表；长线只有方向和终局条件；人物终点存在自然名称与项目实体不一致。

这会造成四种下游表现：故事弧需要自行猜卷级状态，人物退化为主角功能标签，规则只能做背景说明而不能稳定制造代价，长线被重复提及或悬空。正文审校可能发现这些表现，但修改正文无法补齐上游契约。

本轮已完成架构层修复：`fullBookArchitecture.passed=true`，结构问题为空；Foundation 的 architecture、characters、worldview、plot-design 已完成独立审核和作者确认。第 1-6 章仍为原有定稿内容，未因本次架构修复重写。

## 2. 根因与边界

| 根因 | 影响层 | 修复层 | 不采用的代偿 |
| --- | --- | --- | --- |
| 卷只有主题/功能，没有入口状态、压力、退出状态和承诺窗口 | L1 全局骨架 → L2 故事弧 | Foundation architecture contract | 不给正文增加“每章必须推进” |
| 人物只有动机/终点，没有独立行动、限制和代价 | L1 人物 → L2 弧级关系 | Foundation characters contract | 不要求配角每章出场 |
| 规则只有陈述，没有调用成本和不可越过边界 | L1 世界观 → L2 因果 | Foundation worldview contract | 不在正文 prompt 堆规则禁令 |
| 长线只有方向/结局，没有阶段责任和下一次变化 | L1 长程战略 → L2/L3 | Foundation plot-design contract | 不用章节伏笔清单填空 |
| 人物终点使用无法解析或可能歧义的名称 | 跨 Foundation 引用 | 规范 ID + health audit | 不自动猜测或合并角色 |
| 隐藏信息、作者未设计和开放问题混在一起 | L1 信息边界 → L2 揭示窗口 | `informationBoundaries` | 不把所有未知都伪装成伏笔 |

## 3. 修复后的架构契约

### 卷级阶段

六卷保留为资源估计，总估计章节数为 670；每卷现在具备 `entryState`、`pressures`、`exitState` 和 `promiseWindows`。章节数不作为质量目标，承诺窗口也不是逐章兑现清单，而是向故事弧传递责任的时间边界。

### 人物能动性

六名核心人物均具备限制/恐惧、独立欲望与行动策略、选择代价和知识边界。项目内实际追杀者统一为 `char-zhao-xing`，长线和终局引用改用规范 ID，避免 `赵长老`、`赵刑` 等名称漂移。

### 世界规则

五条核心规则均具备 `statement`、`cost`、`boundary`。未知例外不被伪装成已经冻结的规则，正文可通过行动和结果逐步验证，而不是靠解释性段落完成设定交付。

### 长线与信息

三条长线均记录推动者、负责卷、下一次责任、交汇/转化条件和终结条件；`hidden`、`notDesigned`、`open` 三类信息分开保存。长线允许延迟兑现，也允许作者保留未来设计空间。

故事弧层只保留 `threadResponsibilities`；每条 `threadRef` 同时是剧情线规范 ID、本弧责任和下一次可验证推进条件。该字段只解决“长线引用存在但弧内没有责任”的阶段传递缺口，不要求每章兑现长线，也不改变正文表达自由。

重基线使用符合当前契约的 `approvedArc` 作为弧级审核对象，章节权威仍由历史章节证据恢复；历史 artifact 若缺少 `threadResponsibilities`，迁移后标记为 stale，不能静默推断，必须重新生成并审核。

本轮审计还补上了跨章节状态连续性检查。弧级审核会逆向核对相邻章节之间持续存在的物件、伤势、资源、关系、知识和限制；如果状态从“持有/知道/受伤”跳变为“没有/重新获得/未知”，却没有记录丢失、转移、消耗、恢复或新证据，则作为弧级连续性问题报告。该检查约束可验证的状态转化，不把普通名词扩张成逐章清单，也不要求重写正文。

## 4. 当前运行证据

架构健康检查当前返回：

```text
foundation.required: 5/5 approved
fullBookArchitecture.passed: true
volumeCount: 6
estimatedChapterCount: 670
characterCount: 6
longHorizonThreadCount: 3
fullBookArchitecture.issues: []
architecture/health.issues: []
chapters.total: 6
chapters.final: 6
chapters.orphaned: 0
```

健康统计按生命周期解释：无正文的蓝图，或仍处于 planned 的正文，计入 `chapters.planned`；审批前故事弧下的正常蓝图不计入 `chapters.orphaned`。只有无故事弧、章节的关联正文不存在，或故事弧已经 approved 但仍缺正文时，才计入 `chapters.orphaned`。

Foundation 变更会使正在执行的故事弧标记为 `stale`，这是防止旧弧继续消费旧设定的保护，不是正文质量失败。迁移完成后的正式流程已重新执行：当前 `chapter-blueprint` artifact 为 `85957d3f-20c1-473e-bddb-a892d33767d5`，并包含弧级 `threadResponsibilities` 及跨章节物件身份修复。Story Arc 审核 workflow `story-arc-review-b5d753dc-b603-4425-a369-eef26a79e617` 生成 review artifact `9855c6e0-e316-4bcc-a4b3-4ab2f96921f1`，结论为 `passed`、阻塞问题为 0、问题列表为空；超时的独立审核视角作为丢弃视角元数据保留，不会覆盖已完成的完整审核。

随后通过正式作者确认入口完成审批。预览中的 6 个冲突均对应已有 final 正文，因而没有创建或更新章节；确认后当前弧为 `approved/active`，第一批次为 `approved`。6 个 final 文档及其 revision 身份保持不变（revision 17-22，最新仍为第 6 章 revision 22）；本轮没有启动正文章节重审，也没有新增正文 revision。当前模型路由已将通过结构化探针的候选优先用于 `review.arc`，并保留其余候选作为回退。

审核 artifact 中的 `authorityChecks.frozenEvidence` 表示历史批准蓝图的冻结基线，`candidateClaims` 表示由当前弧级蓝图确定性投影出的候选覆盖；二者不是同一份正文快照。定稿章节的实际事实仍以 `chapterMemory`、`authoritativeFacts` 和正文 revision 身份为准，允许作者在弧级架构层修正陈旧规划而不隐式改写正文；若修正需要改变正文表达，才另行进入正式章节审校闭环。

## 5. 后续判定规则

1. 若 health 的 `fullBookArchitecture` 出现 blocker/major，回到 Foundation，不启动正文修订；故事弧批准也会再次阻断这些问题。
2. 故事弧批准必须同时满足 Foundation.required 全部批准和 fullBookArchitecture 无 blocker/major；仅有弧级审核通过不能绕过全书架构门。
3. 若 Foundation 通过但弧级状态 stale，先完成 Story Arc rebase 和弧级审核；若已有 blueprint 且审核失败，只有在匹配的 `awaiting-review` 批次仍存在时，才能通过正式 retry 入口重新进入审核，不重新生成蓝图。批次未完成时，审核只验证当前窗口与弧级退出边界相容，不要求当前窗口提前提供未来章节的退出证据。
4. 只有架构与弧级契约成立后，若正文仍有明确的场景因果、视角、人物行为或语言问题，才进入正式 `chapterReviewWorkflow`。
5. 定稿章节的正文重审必须复用 `review → revise → manuscriptApproval → extractFacts → approveFacts → commit → enrichCharacters`，不能另建离线修订链。

这套分层的目的不是增加创作约束，而是让不同层的问题回到真正拥有该问题的层处理：全书架构负责长期责任，故事弧负责阶段传递，章节蓝图负责局部执行，正文负责把过程写成读者可经历的场景。
