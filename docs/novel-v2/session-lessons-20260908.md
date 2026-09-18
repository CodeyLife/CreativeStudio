# 会话经验沉淀：小说创作管线质量工程（2026-09-08/09）

> 本文档是对 2026-09-08/09 会话的经验沉淀，与 workflow-map.md（机制契约）、mcp-orchestrator.md（工具用法）、
> CRAFT.md（方法论）、prose-craft.yaml（运行时指引）互补——记录的是**实战中验证的操作决策规则与坑位**，
> 均为泛化描述（无特定项目专名，可跨项目复用）。

## 一、管线工程对策的实证结论

1. **targeted 修订的单句原位替换不可靠**（两次实证失败）。模型会"插入新句保留旧句"而不是替换。
   可靠路径决策顺序：**确定性变换 → proposedText（full review + 作者修订稿通道）；语义改写 → targeted；
   targeted 两次失败即切 proposedText，不要第三次。**

2. **机器核对（targetedMachineCheck）的三个边界**：
   - evidence 带定位前缀（如"段落 35："）会误报 evidenceStale——人工 diff 核对覆盖；
   - evidence 跨段拼接时，只要有一段按指令保留，包含性校验仍命中（false stillPresent）；
   - evidenceStale=true 反而是修订成功的预期信号（旧文本被改写）。
   批准 feedback 里必须写明这三类边界的人工核对结论。

3. **同项目审校必须逐章串行**：并行提交撞基线"正式稿基线已变化"。style-normalize 工具已内建串行
   等待，但手工并发提交仍会撞。修复合并策略：同章同族 issue 合并为一个 targeted；三章以上批量变换
   用 style-normalize 逐章跑。

4. **弧规划 manualApproval 分支的信号后必须落库审批**：orchestrate+manual 政策下，批准信号收到后
   只更新工作流状态不够，必须调审批活动落库，否则弧永久停留 awaiting-review 阻塞后续批次与重审。
   分支覆盖盲区靠真实编排暴露（弧 1/2 走 web/auto 路径未触达）。

5. **快照刷新评审竞态**：修订批准后快照重建，新评审可能基于**修订前文本**产出 issue（甚至引用
   已提交正文中根本不存在的内容）。处置前必须先验证库内当前正文实际状态（对象存储直读），
   竞态 issue 直接 ignored 并附实测证据。

## 二、文笔纪律（prose-craft v1.4.0，candidate 已登记）

三类三审未覆盖的品味失败及其机制（泛化描述）：

1. **同章同义比喻堆叠**：一个认知节拍只用一个比喻命名。跨章复用同意象是母题（允许），
   同章复用同判断的比喻是堆叠（不允许）。修复：数比喻个数，≥2 留最贴人物当下处境的一个，
   余改动作/物件/身体状态。

2. **章尾收束三选一**：钩子（具体未解压向下一章）/ 余波（身体物件承载情绪，不新增性格结论）/
   状态落点（一句确认即收束）。检验法：删掉最后三段，读者对"接下来会发生什么"的期待是
   变强还是消失——消失说明在复述而非推进。

3. **对手戏群像反应**：遮住主角内心只读外部行为，每个具名角色的反应是否可区分。随从不是
   主角恐惧的扩音器，要有独立可观察反应（犹豫/多余动作/插话）。

4. **环境异动钩子必须双锚点**：无风叶颤这类氛围钩子需要方位+时序与本章事件的最小关联，
   不揭底但显化关联。

## 三、泛化红线的执行细节（两次纠偏的教训）

1. **机制与案例分层**：机制进共享层（skill/CRAFT.md），案例进 spec 实证记录（workflow-map.md
   "哪些实例验证了机制"）。比喻堆叠的示例词表差点被写进共享方法论——泛化改写为结构描述
   （"同一隐喻家族连环变体：A→A 的场所→A 的动作"）。

2. **沉淀必须走学习闭环**（learning → candidate → promote），不能直接手改 skill 文件：
   candidate 的 scope 四件套（observedSymptom / failingLayer / underlyingMechanism /
   affectedInputClass）+ boundaries + regressionRisks 是泛化审查的结构化载体，promote 后才有
   回滚保障。手改文件等于绕过回归验证与回滚能力。本轮已补登 candidate
   `crc-1788959069599-c680941a`（prose-craft，proposed），回归验证计划：弧 4 生成后用
   "同章比喻计数 + 章尾删三段检验"做 baseline/candidate 对比。

3. **自检工具**：沉淀后对共享层文件跑项目专名扫描（角色名/地名/功法名/比喻词枚举），
   零命中才合规。spec 文档保留案例词属"实证记录"允许范围。

## 四、编排者工作流的最佳实践

1. **弧编排前先拉序列证据**：开放承诺（openPromises）、活跃角色、资产跨度——plotOutline 的
   entryState 必须与末章定稿状态精确衔接，开放承诺是承诺兑现清单的来源。

2. **plotOutline schema 要点**：线索责任每项必须含推进说明（nextAdvance）；预计章节数与
   批次索引语义不同（前者弧内章数，后者全书章序）——批次启动报"已达预计章节数"往往是弧已
   approve 并预创建章节，直接用章节生成工具即可。

3. **弧蓝图外部审核要点**：resolution 承诺解决的核心冲突必须在靠后章节蓝图有承载功能
   （弧收口核对）；评估内部审核 revise 时先看意见是否完整（截断的 opinion 无明确阻断清单，
   不可作为拒绝依据）；批准覆盖 revise 时在 review artifact 的覆盖字段记录完整理由。

4. **manual 门禁推进协议**：作者确认与 passed review 顺序不敏感；不必等自动独立审核落库；
   绝不手动干扰自动修订循环。

## 五、基础设施事实

- Temporal 工作流沙箱禁 node:crypto——worker 共享代码必须无 crypto 依赖（evidence-check.ts
  拆分的根因）。
- MCP HTTP server（默认端口 7654）默认不运行；批量编排用 node --import tsx 直调 executeTool
  更直接，但需手动装配上下文（repository/objects/model/temporal）+ 运行时环境加载。
- 章节正文读取：对象存储直读（object_key 从文档表 JOIN 修订表 JOIN 内容块表获取，
  注意键中反斜杠要替换为正斜杠）。
- 评审竞态的根源是快照重建触发重新评审——修订批准后立即清点 pending 会看到竞态条目，
  等 commit 完成后再清点更可靠。
- worker 是常驻进程，代码更新后必须重启才能生效；工作流在 worker 宕机期间的任务会在
  重启后自动恢复（Temporal 持久化）。
