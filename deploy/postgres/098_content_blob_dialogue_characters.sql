-- content_blobs 增加派生正文指标：引号内有效字符数（正文对白量）。
--
-- 设计依据（docs/novel-v2/state-audit-20261013.md §7 第 5 项）：
-- 正文对白密度此前没有任何通道测量——上游蓝图的 `soloOnlyOrders` / `longestSoloRun`
-- 只能看见"参与者数"，看不见"正文实际对白"；2026-09-22 商业基准对照确诊的
-- 051-080「死亡象限」与 2026-10-13 复测（001-020 对白字占比 6.78% → 061-080 0.67%，
-- 14 章无任何含引号段落）都只能靠一次性人工复盘发现。
--
-- 为什么住 content_blobs：与既有的 `word_count` 完全同型——同属"从正文派生的可复用
-- 结构量"，内容寻址因此天然去重，写一次即可被任意消费方查询（当前消费方是弧规划/
-- 弧审核的 serial-signals 段）。口径定义在 src/novel-v2/word-count.ts 的
-- `countDialogueCharacters`（叶子纯模块，单一事实源）。
--
-- 可空：历史 blob 由 migrate 尾部的 content_blobs 指标回补步（需要正文文本，
-- 走对象存储）惰性补齐；查询侧对 NULL 一律按"不可测"处理，不当作 0。
ALTER TABLE content_blobs ADD COLUMN IF NOT EXISTS dialogue_characters bigint;

ALTER TABLE content_blobs DROP CONSTRAINT IF EXISTS content_blobs_dialogue_characters_nonnegative;
ALTER TABLE content_blobs ADD CONSTRAINT content_blobs_dialogue_characters_nonnegative
  CHECK (dialogue_characters IS NULL OR dialogue_characters >= 0);
