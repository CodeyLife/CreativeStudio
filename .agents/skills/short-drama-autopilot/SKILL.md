---
name: short-drama-autopilot
description: >-
  Autonomous driving protocol for an agent (dsh) producing MiniMax H3 short-drama
  scripts end to end from a creative idea — attention-engine commitment (awe /
  humor / conflict plus one subversion and one signature frame, with self-driven cross-engine
  candidate divergence), idea type classification (narrative vs
  spectacle), generation path selection (stateless POST /v2/short-script-h3 vs self-authored
  payload), local IndexedDB history and self-check
  against the hard contracts (10-15s segments, no adversarial events for
  spectacle or comedy pieces, single-long-shot spatial tours, core imagery
  fidelity, creativeStrategy-frame consistency), and iteration rules. Tool usage
  details live in novel-mcp-orchestration (stage 2.5); directing methodology in
  short-drama-writing; prompt grammar in h3-prompt-writing. Use when told to
  自主产出短剧, autopilot 短剧创作, 把这个创意做成短剧脚本, or generate H3
  short scripts unattended.
metadata:
  audience: autonomous orchestrator agents (dsh headless runs) producing H3 short scripts
  scope: driving protocol only; tool reference is novel-mcp-orchestration stage 2.5,
    directing craft is short-drama-writing, grammar is h3-prompt-writing
---

# 短剧创作自主编排协议（autopilot）

> 当前工具面：20（= 代码 `TOOL_COUNT`，由 `src/novel-v2/__tests__/mcp-tool-face-single-source.test.ts` 校验）。2026-09-24 四批工具面减法 50→41→29→21→20：一批撤 9 个零真实调用工具（action_list、run_complete、receipt_get、rule_target_get、skill_get、chapter_script_h3_submit、memory_grooming_report、chapter_recall_report、model_dispatch），skill 读取并入 novel_skill_query；二批撤 12 增 1（review_submit 并入 action_execute(review.submit)、rule 五个人工步骤合并为 rule_candidate_advance、closed_loop_run/chapter_script_h3/prompt_inspect/invocation_list 等零或近零调用工具撤除，closed_loop_run/chapter_script_h3 能力走 REST）；三批撤 8 合 5（project_create 走 REST、弧规划三入口合一为 story_arc_start(mode=auto|batch|orchestrated)、观测面三对合一、审校双入口合一、决策面合一）；四批撤 project_list（走 REST）。独立短剧已于 2026-09-17 浏览器化：`novel_short_script_h3` / `_brainstorm` / `_submit` 均不在 MCP 工具面内，本文件的短剧生成一律走 `POST /v2/short-script-h3`（stateless，产物存浏览器 IndexedDB）。

## 定位与加载顺序

1. 工具用法（参数契约、幂等规则、双轨路径）以 `novel-mcp-orchestration`
   skill 阶段 2.5 为准。
2. 导演层方法论（节拍设计、钩子、镜头语言）按需加载 `short-drama-writing`；
   吸引力引擎机制（awe/humor 载体与错位机制清单、反转与记忆镜头设计、跨作品
   反同质）见其 `references/attention-hooks.md`；六段结构语法加载 `h3-prompt-writing`。
3. 本 skill 只定义自主运行模式的**驱动协议**。

## 自主驱动流程

### 1. 创意理解：主引擎承诺 + 类型判定

第一步（吸引力设计契约，短剧契约 v10）：**承诺一个主吸引引擎并写出三件套**——
主引擎 `hookType`（awe 震撼奇观 / humor 搞笑反差 / conflict 剧情冲突，通用枚举）、
预期→反转（观众前三秒会预期什么、本片用哪一个可见的画面状态变化推翻或升级到它）、
唯一记忆镜头（全片一个 3-5 秒、一句话可转述的画面，节拍非铺垫即引爆，末段切在它
或其直接余波）。机制细则见 `short-drama-writing/references/attention-hooks.md`。
引擎选择依据创意文本本身：写了人物冲突→conflict；纯场景/奇观→awe（载体五族自选：
巨构/天体/巨形生灵/自然现象/空间法则，避开该题材最著名的默认符号）；创意自带荒诞
反差或可承载"一本正经的错误"→humor。方向开放、创意单薄时**先发散再承诺**：
由你自己穷举 3-6 个跨引擎候选（原 `novel_short_script_h3_brainstorm` 工具已随
2026-09-17 独立短剧浏览器化移除），把近期已产出核心创意作回避清单，从中选定或改造。

第二步（创意意图忠实性契约，不变）：按创意文本判定剧情型/展示型。主引擎与类型正交：
类型管"忠实呈现什么"，引擎管"靠什么抓住观众"。总定位不变：几十秒短镜头创作**不需要
连贯剧情**，产物以镜头画面与镜头美学为主体：

- **剧情型**（创意文本写了人物冲突/目标/阻碍）：把该冲突**作为画面张力呈现**——对峙、反差、动作瞬间、信息揭示即节拍，不展开情节、不铺陈背景故事；开场即冲突、出口即钩子、台词密度、单处伏笔即可（体量适配见 short-drama-writing）。
- **展示型**（只描述场景/世界观/氛围/视觉奇观，无人物对抗）：走视觉展示模式
  ——空间巡游/规模递进/光影氛围为节拍；主引擎为 humor 的展示型则以错位铺垫→
  包袱引爆为节拍，全线一本正经、无人知情。

**硬约束（展示型，对 awe 与 humor 同样生效）**：禁止自行注入追击、战斗、追兵、敌对
对抗事件。创意里没有的冲突不许造——搞笑靠错位与反差引爆，不靠威胁。空间连续运动
（穿越/飞行/下坠/深入/升维）与展示型空间巡游必须用单长镜头多段运镜，只为必要景别/
视角切换才切镜头。

### 2. 生成路径选择

| 场景 | 路径 |
| --- | --- |
| 方向开放/创意单薄 | 你自行跨引擎发散候选（近期母题作 avoidMotifs 回避清单随请求传入）→ 选定 → 常规路径 |
| 常规（默认） | `POST /v2/short-script-h3`（body: idea / durationMode? / targetDurationSeconds? / instruction?）stateless 生成，不经 MCP；返回含 `creativeStrategy` 承诺，核对与预期一致 |
| 需要精细控制节拍/结构 | 先 `novel_skill_query(executionPoint="short.script")` 拿运行时方法论（SkillBundle promptSections，附带 availableSkills 执行点清单）→ 自产模型形态 JSON（**creativeStrategy** / plotBeats / characters / segments 六段字段）→ `POST /v2/short-script-h3` 提交自产 payload（原 `*_submit` 双轨工具已移除，服务端不落库） |

- `idea` 写清谁/何处/什么（≥10 字符）；文化特定核心意象（如御剑飞行）必须
  在创意或 instruction 里写明标准物理呈现（姿势、接触点、相对位置、构图）。
- 时长两档：`durationMode` 缺省 `fixed` 时按 `targetDurationSeconds` 10-180s
  （默认 30s），大场面/战斗序列用长片段；`durationMode="auto"` 时不限时长，
  总时长与片段数由模型依据创意自行编排（节拍完整优先，段数硬顶 36）。
- 命名核心景观必须在画面主体位置占主要视觉焦点与篇幅，氛围元素只作衬托。

### 3. 读回与自检

生成返回的产物**就地核对响应体**即可：独立短剧自 2026-09-17 起服务端零持久化，
`GET /v2/short-script-h3/<scriptId>`、`/list` 与项目级读回端点均已移除（服务端表也随迁移 093 删除），
历史清单与详情都在浏览器 IndexedDB（`ymcp-short-drama-db` 的 scripts store，按 localKey 去重）里读，不是 REST 面。
在跑的只有 stateless 生成端点 `POST http://127.0.0.1:4770/v2/short-script-h3`。

自检清单（全部通过才算完成）：

1. **时长**：每片段 10-15s（大场面 12-15s）；fixed 模式总时长落在目标 ±10s 容差，
   auto（不限时长）模式核对实际总时长=各片段之和且片段数 ≤36。
2. **类型忠实**：展示型产物无追击/战斗/对抗事件；剧情型把创意的冲突情境
   呈现为画面张力节拍（对峙/反差/动作/揭示），不展开情节。
3. **镜头纪律**：空间连续运动是单长镜头多段运镜。
4. **核心意象保真**：文化特定概念的物理呈现正确（如御剑=足踏剑身飞行，
   非手握）；命名景观占据主视觉。
5. **结构完整**：六段结构（subjectDefinitions / summary / retentionAnalysis /
   detailedDescription / overallSoundscape / nonDiegeticMusic）齐全；
   跨镜头主体引用用 <Subject N> 标签。
6. **钩子**：末段切在钩子上（悬念/反转/情绪峰值）；展示型末段切在最强画面瞬间。
7. **片段时间预算**（skill v1.8.0）：每段台词口播估算不超过段时长
   （中文约 4-5 字/秒折算；cinematicHints 出现「台词口播估算」即自检不过）；
   10-15s 段切分镜头以 2-3 镜为常态，节拍不过载（单段一般 1-3 节拍）。
8. **吸引力设计**（契约 v10）：产物 `creativeStrategy` 与画面一致——承诺引擎确实
   主导节拍（humor 的包袱落在具体镜头画面且有冷面反应帧，awe 的奇观载体非题材默认
   符号）；反转以可见画面状态变化落地、静音看片仍成立（若反转/笑点只存活于台词，
   自检不过）；记忆镜头唯一且为末段切点或其余波；对照 `list` 历史清单，核心画面
   构思非既有产物的换皮。cinematicHints 出现「创意策略」缺失提示 = 模型未输出承诺，
   按迭代规则变更输入重生成。

### 4. 迭代规则

自检不过 → 修改输入重新生成。**幂等契约**：同一创意输入会复用既有产物，
必须**变更输入**（细化 idea 文本、调整 instruction、或改 targetDurationSeconds /
durationMode）才会触发重新生成。idea 文本里可直接写死承诺（主引擎、预期与反转、
记忆镜头一句话），这比 instruction 更进入幂等指纹，是首选迭代杠杆。

- 意象失真 → 在 instruction 里加物理呈现约束（描述正确的姿态/构图，不要只说
  "不要画错"）。
- 节奏问题 → 重写创意的节拍表达（如"开场即奇观、中段递进、末段揭示"）。
- 画面全在意料内 / 反转只活在台词 → 在 idea 文本里点名观众预期与推翻它的画面
  状态变化；humor 则点名错位类型与承载错位的具象器物/空间/仪式，要求死面反应帧。
- 与前作同质（换皮）→ 回到 brainstorm 换引擎或换载体族，别在旧载体上打磨。
- 连续 2 次迭代仍不达标 → 停下汇报两版产物差异与你的分析，让用户决策。

### 5. 完成汇报

汇报内容：scriptId、片段数、总时长、各片段一句话摘要（主体/动作/镜头）、
REST 读取路径、以及后续建议（如送 MiniMax H3 生成视频、CreativeStudio UI 查看）。

## 异常处理

| 异常 | 处理 |
| --- | --- |
| ShortScriptInputError（创意过短/越界参数） | 修正输入重试 1 次；仍失败汇报 |
| REST 读不到产物（API 服务未启动） | 检查 novel-v2 API 服务（npm run novel:v2:api，端口 4770）；启动后重读 |
| 生成超时/模型错误 | 重试 1 次；仍失败停下汇报（可能是端点问题，勿放大消耗） |
| 创意信息不足以判定类型（既无冲突又无场景，<10 字符） | 停下向用户要更具体的创意，不要替用户编 |

## 与章节派生的分工

本协议面向**独立短剧**（或关联小说项目的衍生创意短剧）。从已定稿章节派生
剧本走 REST `POST /v2/projects/:projectId/documents/:documentId/script-h3`
（只读派生，不需要本协议的迭代循环；原 MCP 工具 novel_chapter_script_h3
已于 2026-09-24 撤除）——那是小说 autopilot（novel-autopilot）推进定稿后的
自然延伸，流程见 novel-mcp-orchestration 阶段 2.5 路径 A。
