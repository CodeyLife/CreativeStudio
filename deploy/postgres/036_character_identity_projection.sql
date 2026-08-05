-- 角色实体同时承载两类数据：规范 ID 用于关联，name/payload.displayName 用于作者展示。
-- 历史富化曾把模型返回的 characterId 直接写入 name；这里依据已批准的
-- Foundation characters 映射修复可确定的展示名，并为无法确定名称的关系占位保留待补全状态。

WITH foundation_characters AS (
  SELECT
    ps.project_id,
    character->>'id' AS canonical_id,
    character->>'name' AS display_name
  FROM project_plan_sections ps
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE
      WHEN jsonb_typeof(ps.payload->'structuredData'->'characters') = 'array'
        THEN ps.payload->'structuredData'->'characters'
      ELSE '[]'::jsonb
    END
  ) AS character
  WHERE ps.task_key = 'characters'
    AND NULLIF(character->>'id', '') IS NOT NULL
    AND NULLIF(character->>'name', '') IS NOT NULL
), matched_entities AS (
  SELECT DISTINCT ON (entity.id)
    entity.id,
    foundation.canonical_id,
    foundation.display_name
  FROM entities entity
  JOIN foundation_characters foundation
    ON foundation.project_id = entity.project_id
   AND (
     entity.id = 'entity:' || entity.project_id || ':character:' || foundation.canonical_id
     OR entity.name = foundation.canonical_id
     OR entity.name = foundation.display_name
     OR entity.payload->>'canonicalCharacterId' = foundation.canonical_id
   )
  WHERE entity.kind = 'character'
  ORDER BY entity.id, foundation.canonical_id
)
UPDATE entities entity
SET
  name = matched.display_name,
  payload = entity.payload || jsonb_build_object(
    'canonicalCharacterId', matched.canonical_id,
    'displayName', matched.display_name,
    'displayNameStatus', 'identified'
  )
FROM matched_entities matched
WHERE entity.id = matched.id;

UPDATE entities
SET
  name = COALESCE(NULLIF(payload->>'displayName', ''), '未命名角色'),
  payload = payload || jsonb_build_object(
    'canonicalCharacterId', COALESCE(NULLIF(payload->>'canonicalCharacterId', ''), split_part(id, ':character:', 2)),
    'displayName', COALESCE(NULLIF(payload->>'displayName', ''), '未命名角色'),
    'displayNameStatus', 'pending'
  )
WHERE kind = 'character'
  AND payload->>'pendingEnrichment' = 'true'
  AND COALESCE(payload->>'displayNameStatus', '') <> 'identified';
