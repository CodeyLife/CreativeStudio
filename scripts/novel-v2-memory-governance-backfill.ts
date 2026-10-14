#!/usr/bin/env node
/**
 * 记忆治理存量回填脚本（memory-governance-audit-20260909 §5.3/§5.4 存量部分）。
 *
 * 修复代码层契约后，历史数据仍带旧形态，本脚本做三类幂等回填：
 *
 * 1. subject_refs 归一：按人物身份注册表（entities + Foundation characters 别名索引）把
 *    显示名等别名重写为规范 ID；仅精确命中别名才改写，不发明第三种键形态。
 * 2. 指纹回填：
 *    - character-enrichment 知识声明（claim:knowledge:*）此前无 identity_hash/value_hash，
 *      检索层合并键退化为 id 键——按与现役代码同构的公式回填；
 *    - fact-extraction 行主体被归一且为单主体时，按（entity 主体 + 规范谓词）重算 identity_hash
 *      （value_hash 无法从存储行忠实重建——object 结构未持久化——保持原值）。
 * 3. Foundation 投影代际退役：段级单例行（foundation:<projectId>:<taskKey>）supersedes
 *    其余 active 同槽位投影；被退役行保留审计历史。
 *
 * 用法：
 *   node --import tsx scripts/novel-v2-memory-governance-backfill.ts            # dry-run，只打印计划
 *   node --import tsx scripts/novel-v2-memory-governance-backfill.ts --apply    # 执行写回
 *   可选 --project <id> 限定单项目（默认全部项目）。
 *
 * 幂等性：所有更新以"值确实不同"为前提，重复执行为零变更。
 * 边界：不做实体合并（涉及 relations FK 与 payload 合并策略，见审计 §5.4.1 后续）；
 *       不处理语义等价的同义改写（机械不可判定，交由外部事实梳理审核，见审计 §5.5）。
 */
import { Pool } from "pg";
import { buildCharacterIdentityIndex, uniqueCharacterIdentities, type CharacterIdentityIndex, type FoundationCharacter } from "../src/novel-v2/character-identity";
import { canonicalizeFactPredicate, factIdentityHash, factValueHash } from "../src/novel-v2/fact-extraction/fingerprint";
import { mergeRetiredEntityPayload } from "../src/novel-v2/character-enrichment";
import { foundationClaimId } from "../src/novel-v2/foundation-memory";

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const apply = process.argv.includes("--apply");
const onlyProject = option("--project");
const databaseUrl = process.env.DATABASE_URL ?? "postgresql://ymcp:ymcp@127.0.0.1:5432/ymcp";

interface EntityRow { id: string; name: string; payload: Record<string, unknown> | null }

function foundationCharacters(value: unknown): FoundationCharacter[] {
  return Array.isArray(value)
    ? value.filter((item): item is FoundationCharacter => Boolean(item) && typeof item === "object" && !Array.isArray(item))
    : [];
}

async function loadIdentityIndex(pool: Pool, projectId: string): Promise<CharacterIdentityIndex> {
  const [entities, foundation] = await Promise.all([
    pool.query<EntityRow>("SELECT id, name, payload FROM entities WHERE project_id=$1 AND kind='character' ORDER BY name ASC", [projectId]),
    pool.query<{ characters: unknown }>("SELECT payload->'structuredData'->'characters' AS characters FROM project_plan_sections WHERE project_id=$1 AND task_key='characters'", [projectId]),
  ]);
  return buildCharacterIdentityIndex(projectId, entities.rows, foundationCharacters(foundation.rows[0]?.characters));
}

interface Plan {
  subjectRewrites: Array<{ claimId: string; before: string[]; after: string[] }>;
  knowledgeHashBackfills: Array<{ claimId: string; identityHash: string; valueHash: string }>;
  factIdentityBackfills: Array<{ claimId: string; identityHash: string }>;
  foundationRetirements: Array<{ projectId: string; taskKey: string; latestClaimId: string; supersededIds: string[] }>;
  entityMerges: Array<{ projectId: string; legacyEntityId: string; canonicalEntityId: string; mergedPayload: Record<string, unknown> }>;
  predicateRewrites: Array<{ claimId: string; before: string; after: string }>;
}

async function backfillProject(pool: Pool, projectId: string, plan: Plan): Promise<void> {
  const index = await loadIdentityIndex(pool, projectId);
  const identities = uniqueCharacterIdentities(index);
  console.log(`\n=== 项目 ${projectId}：注册人物 ${identities.length} 个 ===`);
  if (!identities.length) {
    console.log("  无注册人物，跳过 subject 归一与指纹回填（Foundation 退役仍执行）。");
  }

  // 实体归并对账（audit §5.4.1）：身份索引把别名实体行映射到同一规范身份时，把旧行
  // payload 并入规范行并标记 mergedInto 退役（与 persistCharacterEnrichment 运行时归并
  // 同一合并实现 mergeRetiredEntityPayload，行保留满足 relations 外键与审计）。
  // loadIdentityIndex 已排除 retired 行（与运行时 loader 同谓词），归并后重复执行计划为零。
  const entityRows = await pool.query<EntityRow>("SELECT id, name, payload FROM entities WHERE project_id=$1 AND kind='character' ORDER BY name ASC", [projectId]);
  const byId = new Map(entityRows.rows.map((row) => [row.id, row]));
  for (const row of entityRows.rows) {
    const canonicalIdentity = index.get(row.id);
    if (!canonicalIdentity || canonicalIdentity.entityId === row.id) continue;
    const canonicalRow = byId.get(canonicalIdentity.entityId);
    if (!canonicalRow) continue;
    const canonicalPayload = canonicalRow.payload ?? {};
    const mergedPayload = mergeRetiredEntityPayload(canonicalPayload, row.payload ?? {});
    if (JSON.stringify(mergedPayload) !== JSON.stringify(canonicalPayload)) {
      plan.entityMerges.push({ projectId, legacyEntityId: row.id, canonicalEntityId: canonicalIdentity.entityId, mergedPayload });
    } else {
      // payload 无差异也要退役旧行，否则别名索引每次重建都会重新映射。
      plan.entityMerges.push({ projectId, legacyEntityId: row.id, canonicalEntityId: canonicalIdentity.entityId, mergedPayload: {} });
    }
  }

  const claims = await pool.query<{ id: string; subject_refs: string[] | null; predicate: string | null; content: string; identity_hash: string | null; value_hash: string | null }>(
    `SELECT id, subject_refs, predicate, content, identity_hash, value_hash
     FROM memory_claims WHERE project_id=$1 AND lifecycle_status IN ('active','staged')`,
    [projectId],
  );

  for (const claim of claims.rows) {
    const refs = claim.subject_refs ?? [];
    if (!refs.length) continue;
    const normalized = refs.map((ref) => index.get(ref.trim())?.canonicalId ?? ref);
    const changed = normalized.some((ref, i) => ref !== refs[i]);
    if (changed) {
      plan.subjectRewrites.push({ claimId: claim.id, before: refs, after: normalized });
    }
    const isKnowledgeClaim = claim.id.startsWith("claim:knowledge:");
    if (isKnowledgeClaim) {
      // predicate 列同步归一（复审发现：identity/value 指纹已按"知晓"重算，但列仍存
      // character-knows——所有消费方都会 canonicalize，不影响正确性，但存储层应自洽）。
      const canonicalPredicate = canonicalizeFactPredicate(claim.predicate ?? "");
      if (canonicalPredicate && canonicalPredicate !== claim.predicate) {
        plan.predicateRewrites.push({ claimId: claim.id, before: claim.predicate!, after: canonicalPredicate });
      }
      const subject = normalized[0];
      if (!subject) continue;
      const knowledgeFact = {
        subject: { kind: "entity" as const, id: subject },
        predicate: "character-knows",
        object: { kind: "string" as const, value: claim.content },
        polarity: "affirmed" as const,
        truthStatus: "objective" as const,
      };
      const identityHash = factIdentityHash(knowledgeFact);
      const valueHash = factValueHash(knowledgeFact);
      if (claim.identity_hash !== identityHash || claim.value_hash !== valueHash) {
        plan.knowledgeHashBackfills.push({ claimId: claim.id, identityHash, valueHash });
      }
    } else if (changed && claim.identity_hash && normalized.length === 1) {
      // fact-extraction 行：单主体且命中注册表时按（entity 主体 + 规范谓词）重算 identity_hash。
      const fact = { subject: { kind: "entity" as const, id: normalized[0] }, predicate: canonicalizeFactPredicate(claim.predicate ?? "") };
      const identityHash = factIdentityHash(fact);
      if (claim.identity_hash !== identityHash) {
        plan.factIdentityBackfills.push({ claimId: claim.id, identityHash });
      }
    }
  }

  // Foundation 投影代际退役：段级单例（foundation:<projectId>:<taskKey>）supersedes
  // 其余 active 同槽位投影。
  //
  // 勘误（2026-10-13，state-audit-20261013 §7-3）：本步此前按 pre-singleton 的
  // per-artifact 形态拼 `foundation:<artifactId>` 作为存活行（见 foundation-memory.ts:23-31
  // 的单例化说明）。单例化后 recordFoundationClaim 不再为非最新 artifact 落投影行
  // （postgres-repository.ts:5714-5718），于是该 id 常常根本没有对应行——UPDATE 命中 0 行、
  // 静默无操作；即便命中，写的也是已被单例 supersedes 的陈旧行，把代际方向写反。
  // 现改为以单例 id 为目标，并在单例行不存在时跳过（此时该 taskKey 尚未单例化，
  // 退役由 recordFoundationClaim 落单例时完成）。
  const artifacts = await pool.query<{ id: string; task_key: string | null }>(
    `SELECT id, payload->>'taskKey' AS task_key
     FROM artifacts WHERE project_id=$1 AND kind='foundation' ORDER BY created_at ASC, id ASC`,
    [projectId],
  );
  const taskKeys = new Set<string>();
  for (const artifact of artifacts.rows) {
    if (artifact.task_key) taskKeys.add(artifact.task_key);
  }
  for (const taskKey of taskKeys) {
    const latestClaimId = foundationClaimId(projectId, taskKey);
    // 单例行是唯一合法存活行；不存在则该槽位无可退役目标（幂等：重复执行计划为零）。
    const singleton = await pool.query<{ supersedes: string[] | null }>(
      "SELECT supersedes FROM memory_claims WHERE project_id=$1 AND id=$2",
      [projectId, latestClaimId],
    );
    if (!singleton.rows.length) continue;
    const alreadySuperseded = singleton.rows[0].supersedes ?? [];
    const prior = await pool.query<{ id: string }>(
      `SELECT id FROM memory_claims
       WHERE project_id=$1 AND lifecycle_status='active' AND subject_refs && $2::text[] AND id <> $3
         AND id <> ALL($4::text[])`,
      [projectId, [`foundation:${taskKey}`], latestClaimId, alreadySuperseded],
    );
    const supersededIds = prior.rows.map((row) => row.id);
    if (supersededIds.length) {
      plan.foundationRetirements.push({ projectId, taskKey, latestClaimId, supersededIds });
    }
  }
}

async function applyPlan(pool: Pool, plan: Plan): Promise<void> {
  for (const rewrite of plan.subjectRewrites) {
    await pool.query("UPDATE memory_claims SET subject_refs=$2 WHERE id=$1", [rewrite.claimId, rewrite.after]);
  }
  for (const backfill of plan.knowledgeHashBackfills) {
    await pool.query("UPDATE memory_claims SET identity_hash=$2, value_hash=$3 WHERE id=$1", [backfill.claimId, backfill.identityHash, backfill.valueHash]);
  }
  for (const backfill of plan.factIdentityBackfills) {
    await pool.query("UPDATE memory_claims SET identity_hash=$2 WHERE id=$1", [backfill.claimId, backfill.identityHash]);
  }
  for (const rewrite of plan.predicateRewrites) {
    await pool.query("UPDATE memory_claims SET predicate=$2 WHERE id=$1", [rewrite.claimId, rewrite.after]);
  }
  for (const merge of plan.entityMerges) {
    if (Object.keys(merge.mergedPayload).length) {
      await pool.query("UPDATE entities SET payload=$2::jsonb WHERE id=$1", [merge.canonicalEntityId, JSON.stringify(merge.mergedPayload)]);
    }
    // 退役旧行：行保留满足 relations 外键与审计，payload.mergedInto 使其从所有
    // 身份索引与档案读取中消失（与运行时 persistCharacterEnrichment 归并同语义）。
    await pool.query(
      "UPDATE entities SET payload = payload || jsonb_build_object('mergedInto', $2::text, 'mergedAt', to_char(now(), 'YYYY-MM-DD\"T\"HH24:MI:SSOF')) WHERE id=$1",
      [merge.legacyEntityId, merge.canonicalEntityId],
    );
  }
  for (const retirement of plan.foundationRetirements) {
    // 退役 = 把其余 active 同槽位投影 id 记入最新投影行的 supersedes；
    // 检索层（searchMemory SQL 的 NOT EXISTS + Qdrant 过滤）随即屏蔽被退役行，历史保留审计。
    await pool.query(
      "UPDATE memory_claims SET supersedes=(SELECT array_agg(DISTINCT x) FROM unnest(supersedes || $2::text[]) AS x) WHERE id=$1",
      [retirement.latestClaimId, retirement.supersededIds],
    );
  }
}

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: databaseUrl });
  const plan: Plan = { subjectRewrites: [], knowledgeHashBackfills: [], factIdentityBackfills: [], foundationRetirements: [], entityMerges: [], predicateRewrites: [] };
  try {
    const projects = onlyProject
      ? await pool.query<{ id: string }>("SELECT id FROM novel_projects WHERE id=$1", [onlyProject])
      : await pool.query<{ id: string }>("SELECT id FROM novel_projects ORDER BY created_at ASC");
    if (!projects.rows.length) throw new Error(`未找到项目（--project=${onlyProject ?? "全部"}）`);
    for (const project of projects.rows) {
      await backfillProject(pool, project.id, plan);
    }

    console.log("\n===== 回填计划 =====");
    console.log(`subject_refs 归一：${plan.subjectRewrites.length} 行`);
    for (const rewrite of plan.subjectRewrites.slice(0, 10)) {
      console.log(`  ${rewrite.claimId}\n    ${JSON.stringify(rewrite.before)} -> ${JSON.stringify(rewrite.after)}`);
    }
    if (plan.subjectRewrites.length > 10) console.log(`  … 其余 ${plan.subjectRewrites.length - 10} 行省略`);
    console.log(`knowledge 指纹回填（identity+value）：${plan.knowledgeHashBackfills.length} 行`);
    console.log(`fact identity_hash 重算（主体归一后）：${plan.factIdentityBackfills.length} 行`);
    console.log(`Foundation 代际退役：${plan.foundationRetirements.length} 组`);
    for (const retirement of plan.foundationRetirements) {
      console.log(`  ${retirement.projectId} [${retirement.taskKey}] ${retirement.latestClaimId} 退役 ${retirement.supersededIds.length} 条`);
    }
    console.log(`实体归并（payload 并入规范行 + mergedInto 退役）：${plan.entityMerges.length} 行`);
    for (const merge of plan.entityMerges.slice(0, 10)) {
      console.log(`  ${merge.projectId} ${merge.legacyEntityId} -> ${merge.canonicalEntityId}${Object.keys(merge.mergedPayload).length ? "（含 payload 合并）" : "（仅退役）"}`);
    }
    if (plan.entityMerges.length > 10) console.log(`  … 其余 ${plan.entityMerges.length - 10} 行省略`);
    console.log(`predicate 列归一（character-knows → 知晓）：${plan.predicateRewrites.length} 行`);

    if (!apply) {
      console.log("\n[dry-run] 未写回任何数据。确认计划后加 --apply 执行。");
      return;
    }
    await applyPlan(pool, plan);
    console.log("\n[apply] 回填完成。");
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(`[memory-governance-backfill] 执行失败：${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
