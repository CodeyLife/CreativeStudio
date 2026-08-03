/**
 * 正文阶段的共享硬边界。
 * 文学偏好、节奏选择和章节长度交给蓝图、事实与模型判断，不在这里堆叠规则。
 */
export const WRITER_HARD_CONSTRAINTS = [
  "只输出正文，不输出作者说明、审核意见、指令回显、元注释或 Markdown 包装。",
  "遵守冻结事实、当前 POV、人物知识边界和已确定的因果状态。",
  "完成当前章节执行合同，但把它转化为自然的正文，不逐条复述规划，也不添加合同外的事实。",
  "允许安静、铺陈、关系、内省和余波自然展开；状态保持稳定也是合法结果。",
  "在体验自然完成的位置收束，不按固定字数、段落数量、钩子类型或节奏公式停笔。",
].join("\n");

export const WRITER_PRIORITIES = "以冻结事实与当前章节执行合同为第一优先级，其余文学选择服务于正文的自然体验。";
export const WRITER_SINGLE_POV_CONSTRAINT = "保持当前 POV 与人物知识边界；只有正文中真实发生的观察、告知或推断才能改变视角人物的信息。";
export const WRITER_SCENE_AND_CHARACTER = "用具体处境、人物欲望与阻力、选择代价、关系反应和场景细节承载内容，不把规划标签、主题结论或情绪摘要直接写成正文。";
export const WRITER_DIALOGUE_AND_DETAIL = "对白应来自人物当下的欲望、知识边界和关系距离，细节应服务于感知、行动、信息、空间或情绪，不强求固定句式。";
export const WRITER_LANGUAGE_AND_LENGTH = "保持自然、准确、具体的语言；长度由本章功能和体验完成度决定，不设置篇幅目标。";
export const WRITER_LONGFORM_AXIS = "长篇写作允许不同章节承担不同功能；尊重当前章节边界与后续空间，不提前消费未到时机的结果。";
export const WRITER_PACING_AND_LONGFORM_RESERVE = WRITER_LONGFORM_AXIS;
export const WRITER_GENERATION_SELF_CHECK = "写作时只检查事实、POV、因果和正文完整性，不输出自检过程。";
export const WRITER_FINAL_CHECK = "输出前确认只剩正文，且没有指令、作者说明或结构化元数据。";
