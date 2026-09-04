/**
 * 故事弧章节上限常量（浏览器安全的无依赖叶子模块）。
 *
 * 从 story-arc.ts 抽出的原因：MCP 工具元数据（前端面板展示）需要这两个
 * 常量构造 inputSchema，而 story-arc.ts 依赖 node:crypto，被浏览器包拉入
 * 会导致构建失败。共享常量放本模块后，前端只依赖纯常量叶子，服务端逻辑
 * （story-arc.ts）从这里 import 并 re-export，既有引用方无需改动。
 */

// TODO P2: 这两个上限应可配置——当前 80 覆盖单弧最大合理章数，
// 16 与单批次章节窗口对齐。未来应由项目级配置或弧级预算决定，而非硬编码。
export const MAX_EXPECTED_CHAPTER_COUNT = 80;
export const MAX_CHAPTER_HINTS = 16;
