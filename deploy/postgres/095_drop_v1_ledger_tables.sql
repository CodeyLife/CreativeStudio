-- 095_drop_v1_ledger_tables.sql
-- 删除四张"零行 + 零读写方"的表：facts、fact_sources、quality_gates、skills。
-- （作者 2026-09-20 裁决：死表删除。同批已删的还有 093 的八张与零引用依赖。）
--
-- 判据（可复跑：`tmp/dead-table-sweep.cjs`，沿用 093 那轮定下的三条扫描纪律）：
-- 从本仓迁移文本派生"存活表全集"时先剥 SQL 注释（头注释里的示例 SQL 会被读成凭空多出的表）；
-- 代码引用按 **SQL 动词 + 表名** 计数而不是裸表名（`FROM facts` 与 `DELETE FROM facts` 不是一回事，
-- 而解释"为什么删它"的注释与断言也不算消费者）；不整文件排除（同一文件往往另有真 SQL）。
-- 全仓（src / scripts，剥注释）扫下来 73 张存活表里只有这四张既无人写也无人读：
--
-- - facts / fact_sources (001, 两表互以外键相连)：v1 时代的"事实"账。真源早已是
--   `memory_claims` + `memory_claim_sources`（审批治理、检索可见性、supersedes 退役都在那侧），
--   v2 的 kind 枚举、REST 路由与资料工作台都不再出现 facts。实测 `ymcp` 与 `ymcp_test` 均 0 行。
--   唯一代码引用是 commit 回滚路径里"顺手清掉历史残留行"的两句 DELETE（0 行 ⇒ 该分支永不命中），
--   已随本迁移一并移除——留着比删掉更危险：撤表后它会在一次正常回滚里抛
--   `relation "facts" does not exist`，把回滚本身变成失败。
-- - quality_gates (001)：v1 质量门表，0 行、零引用。v2 的质量门是代码里的 `qualityGates`
--   契约与 `evaluateCommitGate`，另有 `skill_definitions.quality_gates` 列（同名不同物，勿混）。
-- - skills (001)：v1 技能表，0 行、零引用。v2 由 `skill_definitions`（带溯源不变量，见迁移 082）
--   与运行时 skill 执行点投影承担；`skill_bundles` 是装配产物，也仍在用。
--
-- 与 093 的关键差异（取证过，不是照抄那次的做法）：这四张表**没有任何归属序列**
-- （`pg_depend` 里 deptype='a' 指向它们的序列为空），因此不存在"沙箱副本的 id 默认值钉住公共
-- 序列 ⇒ DROP 报 2BP01"那条链，093 里的 `OWNED BY NONE` 解绑步骤在这里既不需要也不该照搬。
-- 入向外键只有 `fact_sources.fact_id → facts.id` 一条，两表同批删，顺序是先子表后父表。
-- DROP 仍刻意不带 CASCADE：若真库上有本迁移没预料到的依赖，应当炸响并整体回滚。
--
-- 配套改动（缺一不可，都是 093 实测过的耦合面）：`EXPERIMENT_RUNTIME_TABLES` 去掉这四个名字
-- ——实验沙箱按该清单逐张 `LIKE public.x INCLUDING ALL` 克隆，留着名字会在每次建工作区时抛
-- "V2 runtime schema 不完整"；`scripts/repair-story-arc-order.ts` 去掉对 `facts` 的章序修正。
--
-- 不可逆面：四表 0 行 ⇒ 不丢任何数据，只丢 schema；schema 可由 001 重建。
-- 幂等：`IF EXISTS`，重复 migrate 为 no-op；迁移文件内不自管事务（本仓纪律）。
-- 范围外：public 里约 69 张非本仓迁移建的表（LiteLLM 等共用同库的外部应用对象）一律不碰；
-- `timeline_events` 同样 0 行却**不是**死表——它有真的写入者（postgres-repository.ts:2457）与读取者
-- （:2276），只是本部署还没产出时间线事件；095 的判据始终是"零读写方"，不是"零行"。

DROP TABLE IF EXISTS fact_sources;
DROP TABLE IF EXISTS facts;
DROP TABLE IF EXISTS quality_gates;
DROP TABLE IF EXISTS skills;
