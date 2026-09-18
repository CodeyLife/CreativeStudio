-- PL-5 修复②（product-audit-20260910 A4/B2）：伏笔兑现必须走与 promise 同一张兑现账，
-- 单一入口。此前 payoffs 只以 promise_id 建模（NOT NULL），伏笔兑现只把 foreshadowing.status
-- 翻成 fulfilled 而不落任何兑现记录，导致"兑现账本"对伏笔完全失明（实测 33 条 fulfilled
-- 伏笔在 payoffs 表 0 行）。泛化建模：payoffs 每行引用**恰好一个**兑现目标（promise 或
-- foreshadowing），CHECK 约束强制互斥，未来新增兑现种类同表扩展。
ALTER TABLE payoffs ADD COLUMN IF NOT EXISTS foreshadowing_id TEXT;

-- 放宽旧 NOT NULL 目标列，再以下方 CHECK 统一"恰好一个目标"不变式。
ALTER TABLE payoffs ALTER COLUMN promise_id DROP NOT NULL;

DO $$ BEGIN
  ALTER TABLE payoffs ADD CONSTRAINT payoffs_foreshadowing_fkey
    FOREIGN KEY (foreshadowing_id) REFERENCES foreshadowing(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE payoffs DROP CONSTRAINT IF EXISTS payoffs_exactly_one_target;
ALTER TABLE payoffs ADD CONSTRAINT payoffs_exactly_one_target
  CHECK ((promise_id IS NULL) <> (foreshadowing_id IS NULL));

CREATE INDEX IF NOT EXISTS payoffs_foreshadowing_idx ON payoffs(foreshadowing_id) WHERE foreshadowing_id IS NOT NULL;

-- 一次性回填：把历史上"仅翻 status"的已兑现伏笔补进兑现账，令账实相符且幂等可重放。
-- 保留 payoff_revision_id 作为兑现修订证据；evidence 标记来源，供审计识别合成行。
INSERT INTO payoffs(id, promise_id, foreshadowing_id, revision_id, evidence)
SELECT 'foreshadowing-payoff:' || f.id, NULL, f.id, f.payoff_revision_id,
       jsonb_build_object('backfilled', true, 'source', 'fulfilled-status-only')
FROM foreshadowing f
WHERE f.status = 'fulfilled'
  AND f.payoff_revision_id IS NOT NULL
  AND EXISTS (SELECT 1 FROM manuscript_revisions mr WHERE mr.id = f.payoff_revision_id)
  AND NOT EXISTS (SELECT 1 FROM payoffs p WHERE p.foreshadowing_id = f.id)
ON CONFLICT (id) DO NOTHING;
