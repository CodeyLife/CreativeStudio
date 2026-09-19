-- 093_drop_zero_reference_tables.sql
-- 删除 8 张"零读写方"表（作者 2026-09-19 裁决：清除死表等冗余数据；short_scripts 的 13 行
-- 存量连数据一起删、不导档）。
--
-- 判据（可复跑，判据本身已固化成 `experiment-schema-ownership.test.ts` 的两条派生锁）：
-- 剥掉注释行与"实验清理清单"字面量数组后，src / scripts / web / admin 全仓对这些表名零命中
-- ——既无生产者也无消费者。只在清理清单里出现不等于有人用它：那张清单说的是"清实验工作区时删
-- 哪些表"，而同一文件另有真 SQL（experiment_workspaces 的 INSERT/UPDATE/DELETE），所以只能剥
-- 那段数组——整文件排除会把活表误判成死表（本次实测误判过 `experiment_workspaces`）。
--
-- 逐张定性（ymcp 只读取证，2026-09-19 行数）：
-- - short_scripts (13 行, 050)：创意短剧服务端存储。2026-09-17 起独立短剧全部改存浏览器
--   IndexedDB（src/lib/shortDramaStore.ts），生成走无状态 POST /v2/short-script-h3，代码侧
--   读写路径已移除 ⇒ 13 行是切换前的存量残留，按当时既定的"放弃存量"处理。
-- - short_drama_workspaces / short_drama_materials (0 行, 090)：同一方案的服务端容器与素材库，
--   随该方案一起废弃（§九 F8/F9 行登记为死表，当时留待本次裁决）。
-- - character_knowledge (0 行, 001)：v1 人物知识边界表，现由 memory_claims.knowledgeScope 承担。
-- - skill_versions / skill_bindings (0 行, 001)：v1 技能轨，现由 skill_definitions + 运行时 skill
--   执行点投影承担。
-- - memory_snapshots / usage_ledger (0 行, 001)：v1 遗留，全仓无写路径。
--
-- 步骤①是这条迁移真正的难点，也是一次实测教训。`createExperimentSchema` 用
-- `CREATE TABLE x (LIKE public.x INCLUDING ALL)` 给每个实验工作区克隆整套运行表，而 LIKE 的
-- 默认值是**照抄表达式**：沙箱副本的 id 默认值直接引用 public 的序列（不是另建一个）。于是
-- "表 → 归属序列 → 沙箱副本默认值"这条链让 DROP 报 2BP01（最小复现：1 张父表 + 1 个副本即可，
-- 测试库当时 91 个在册沙箱同理）。
-- 要切断的是序列归属这一条边，不是沙箱本身，故这里只做 `OWNED BY NONE`（本仓这几张表最多各一
-- 个归属序列，语句数恒定）。
--
-- 刻意不做的两种"看着更彻底"的写法，两条都在真库上试过并否定：
-- - 遍历各沙箱 ALTER COLUMN DROP DEFAULT / DROP 克隆表：几十个沙箱 × 8 张表 ⇒ 单事务内关系锁
--   打爆共享锁表（SQLSTATE 53200 out of locks）。
-- - DROP SCHEMA ... CASCADE 清"无登记行的孤儿沙箱"：危险且本次就是它先炸的（同样 53200）。
--   登记行是建 schema **之后**才插的，迁移若落在那个窗口里就会把在飞实验整库删掉；"孤儿"判据
--   本身依赖登记表的即时状态，不该在迁移里赌。ymcp 现有 11 个零登记 experiment_* schema
--   （experiment_workspaces 里 0 行、代码只按登记表寻址 ⇒ 永不可达），作为独立运维项登记在
--   workflow-map「死表清除」条：要清也得由知道在飞状态的应用侧按清单来做。
--
-- 残留面如实说明：解绑后这些序列仍被沙箱副本的默认值引用而删不掉，本轮实测留下 1 个空序列
-- （public.usage_ledger_id_seq，其余 7 张表的 id 不是 serial）——这是"不碰沙箱"的代价，比赌一次 CASCADE 划算。
--
-- 步骤②的 DROP 刻意不带 CASCADE：公共表若还有本迁移没预料到的依赖，应当炸响并整体回滚，
-- 而不是把别人的列静默连带删掉。
--
-- 不可逆面：0 行的 7 张只丢 schema；short_scripts 丢 13 行元数据（正文在对象存储，本机本就
-- 读不到）。schema 可由 001/050/090 重建，数据不行——这是作者裁决明确接受的取舍。
-- 幂等：IF EXISTS + 归属查询无行即空转，重复 migrate 为 no-op；迁移文件内不自管事务（本仓纪律）。
-- 范围外：public 共 150 张表，其中约 69 张不是本仓迁移建的（LiteLLM 等共用同库的外部应用对象），
-- 一律不碰；facts/fact_sources（0 行）也不碰——它仍是 commit 回滚路径的清理写入目标。

DO $$
DECLARE
  victims TEXT[] := ARRAY['short_scripts', 'short_drama_materials', 'short_drama_workspaces',
                          'character_knowledge', 'skill_versions', 'skill_bindings',
                          'memory_snapshots', 'usage_ledger'];
  names    TEXT[];
  name     TEXT;
  detached INT := 0;
BEGIN
  -- 先聚合成数组再逐条改归属：在 FOR 游标里边扫 pg_depend 边改依赖，后续迭代会打在已经变动的
  -- 对象上（真库报 cannot open relation），数组形态则一次读清再改。
  SELECT array_agg(DISTINCT seq.relname) INTO names
  FROM pg_depend d
  JOIN pg_class seq ON seq.oid = d.objid AND seq.relkind = 'S'
  JOIN pg_class tbl ON tbl.oid = d.refobjid AND tbl.relkind = 'r'
  JOIN pg_namespace sn ON sn.oid = seq.relnamespace
  JOIN pg_namespace tn ON tn.oid = tbl.relnamespace
  WHERE d.deptype = 'a'
    AND d.classid = 'pg_class'::regclass
    AND d.refclassid = 'pg_class'::regclass
    AND d.refobjsubid > 0
    AND sn.nspname = 'public'
    AND tn.nspname = 'public'
    AND tbl.relname = ANY (victims);

  FOREACH name IN ARRAY coalesce(names, '{}'::text[])
  LOOP
    EXECUTE format('ALTER SEQUENCE public.%I OWNED BY NONE', name);
    detached := detached + 1;
  END LOOP;
  RAISE NOTICE '093：解除 % 个序列对这些表的归属（沙箱副本仍引用它们，故不删序列）', detached;
END $$;

DROP TABLE IF EXISTS short_scripts, short_drama_materials, short_drama_workspaces,
                     character_knowledge, skill_versions, skill_bindings,
                     memory_snapshots, usage_ledger;
