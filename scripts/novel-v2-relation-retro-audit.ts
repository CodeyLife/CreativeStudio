#!/usr/bin/env node
/**
 * PL-4 存量关系追溯治理（product-audit-20260910 B4 作者授权 2026-09-11）。
 *
 * 正文可指认门上线前的存量抽取关系（source_revision_id 非空 = enrichment 产物，
 * 人工/legacy 关系不属本面）当时全部绑定了 valid_from。本脚本以**与运行时同一
 * 判定实现**（humanMentionNamesFor + isCharacterMentionedIn + normalizeRelationPredicate，
 * 零复刻零第二套）追溯每条：
 *   ① 两端可指称名未同时命中来源版本正文 → valid_from 置 NULL（降规划候选通道：
 *      searchGraphMemory 的排除谓词就是 valid_from IS NULL，与运行时写入面同源，
 *      无需另打标记）；
 *   ② 谓词按受控枚举归一（白名单直通、词形收进 `其他:<标签>`、句子形态归通用标签）。
 *
 * 用法：node --import tsx scripts/novel-v2-relation-retro-audit.ts            # dry-run
 *       ... --apply                                                          # 写回
 *       可选 --project <id>（默认全部有抽取来源关系的项目）。
 * 幂等：仅值确实不同才改；重复执行计划为零。正文对象缺失 → 该行保守跳过（无证据
 * 不改判，与运行时"调用方无正文证据保守放行"同语义）。
 */
import { Pool } from "pg";
import { createDefaultObjectStore } from "../src/novel-v2/object-store";
import { buildCharacterIdentityIndex, humanMentionNamesFor, isCharacterMentionedIn, type CharacterIdentityIndex } from "../src/novel-v2/character-identity";
import { normalizeRelationPredicate } from "../src/novel-v2/character-enrichment";
import { loadRuntimeEnv } from "../scripts/runtime-env.mjs";

Object.assign(process.env, loadRuntimeEnv(process.cwd()));
const databaseUrl = process.env.DATABASE_URL ?? "postgresql://ymcp:ymcp@127.0.0.1:5432/ymcp";
const apply = process.argv.includes("--apply");
const argOf = (name: string) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };
const onlyProject = argOf("--project");

interface RelationRow { id: string; project_id: string; subject_id: string; object_id: string; predicate: string; valid_from: string | null; source_revision_id: string | null }

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: databaseUrl });
  const store = createDefaultObjectStore();
  try {
    const projects = onlyProject
      ? (await pool.query<{ id: string }>("SELECT id FROM novel_projects WHERE id=$1", [onlyProject])).rows
      : (await pool.query<{ id: string }>("SELECT DISTINCT project_id AS id FROM relations WHERE source_revision_id IS NOT NULL ORDER BY project_id")).rows;
    let demoted = 0, normalized = 0, skippedNoEvidence = 0, checked = 0;
    for (const { id: projectId } of projects) {
      const entities = await pool.query<{ id: string; name: string; payload: Record<string, unknown> | null }>(
        "SELECT id, name, payload FROM entities WHERE project_id=$1 AND kind='character' ORDER BY name ASC", [projectId],
      );
      const foundation = await pool.query<{ characters: unknown }>(
        "SELECT payload->'structuredData'->'characters' AS characters FROM project_plan_sections WHERE project_id=$1 AND task_key='characters'", [projectId],
      );
      const charRows = Array.isArray(foundation.rows[0]?.characters)
        ? (foundation.rows[0].characters as Array<Record<string, unknown>>).filter((c) => c && typeof c === "object")
        : [];
      const index: CharacterIdentityIndex = buildCharacterIdentityIndex(projectId, entities.rows, charRows as never);
      const identityByEntity = new Map<string, ReturnType<typeof index.get>>();
      for (const row of entities.rows) {
        const identity = index.get(row.id);
        if (identity) identityByEntity.set(row.id, identity);
      }
      // 正文按来源版本缓存（同版本多条关系只取一次对象）。
      const textCache = new Map<string, string | undefined>();
      const loadRevisionText = async (revisionId: string): Promise<string | undefined> => {
        if (textCache.has(revisionId)) return textCache.get(revisionId);
        const artifact = await pool.query<{ object_key: string | null }>(
          `SELECT a.object_key FROM artifacts a JOIN manuscript_revisions mr ON mr.artifact_id=a.id WHERE mr.id=$1`, [revisionId],
        );
        let text: string | undefined;
        const key = artifact.rows[0]?.object_key;
        if (key) {
          try { text = await store.getText(key); } catch { text = undefined; }
        }
        textCache.set(revisionId, text);
        return text;
      };
      const relations = await pool.query<RelationRow>(
        `SELECT id,project_id,subject_id,object_id,predicate,valid_from::text,source_revision_id FROM relations
         WHERE project_id=$1 AND source_revision_id IS NOT NULL ORDER BY id`, [projectId],
      );
      for (const rel of relations.rows) {
        checked += 1;
        let nextValidFrom: string | null = rel.valid_from;
        const nextPredicate = normalizeRelationPredicate(rel.predicate ?? "");
        const bodyText = rel.source_revision_id ? await loadRevisionText(rel.source_revision_id) : undefined;
        if (!bodyText) {
          skippedNoEvidence += 1; // 无正文证据：不改判（保守放行同运行时）。
        } else {
          const mentionOk = [rel.subject_id, rel.object_id].every((endpointId) => {
            const identity = identityByEntity.get(endpointId);
            if (!identity) return true; // 端点不在身份索引（非人物实体）：无"可指称名"概念，不据缺名降级。
            return isCharacterMentionedIn(bodyText, humanMentionNamesFor(index, identity));
          });
          if (!mentionOk && rel.valid_from !== null) {
            nextValidFrom = null;
            demoted += 1;
            console.log(`  [降级] ${rel.id}\n    ${rel.subject_id} —${rel.predicate}→ ${rel.object_id}（来源版本正文未同时命中两端可指称名）`);
          }
        }
        if (nextPredicate !== rel.predicate) {
          normalized += 1;
          console.log(`  [归一] ${rel.id}: ${rel.predicate} → ${nextPredicate}`);
        }
        if (apply && (nextValidFrom !== rel.valid_from || nextPredicate !== rel.predicate)) {
          await pool.query("UPDATE relations SET predicate=$2, valid_from=$3::bigint WHERE id=$1", [rel.id, nextPredicate, nextValidFrom]);
        }
      }
    }
    console.log(`\n===== PL-4 存量追溯${apply ? "（已写回）" : "（dry-run）"} =====`);
    console.log(`检查 ${checked} 条抽取来源关系；降级规划候选 ${demoted}；谓词归一 ${normalized}；无正文证据跳过 ${skippedNoEvidence}`);
    if (!apply) console.log("[dry-run] 未写回任何数据。确认计划后加 --apply 执行。");
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(`[relation-retro-audit] 失败：${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
