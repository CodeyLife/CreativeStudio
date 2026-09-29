import { createHash, randomUUID } from "node:crypto";
import type { Artifact, ChapterMemory, MemoryClaim, SkillProvider } from "../protocol";
import type { ModelGateway } from "../model-gateway";
import type { ModelRoutingSnapshot } from "../model-routing";
import type { ObjectStoreAdapter } from "../object-store";
import type { MemoryIndex } from "../qdrant-memory";
import type { ChapterStateRebuildRepositoryAccess } from "../repository-capabilities";
import { extractFactsWithStats } from "../fact-extraction";
import { loadCharacterIdentityRegistry } from "../character-enrichment";
import { uniqueCharacterIdentities, type CharacterIdentityIndex } from "../character-identity";
import { buildChapterMemoryProjection, chapterMemoryAsClaim, generateChapterMemoryOutput } from "../chapter-memory";
import { resolveStageSkillBundle } from "../skill-runtime";
export { ChapterStateRebuildConflictError, HISTORICAL_CHAPTER_REBUILD_REQUIRES_CASCADE } from "./chapter-state-rebuild-conflict";

export interface RebuildCommittedChapterStateResult {
  projectId: string;
  documentId: string;
  revisionId: string;
  factArtifactId: string;
  activatedClaims: MemoryClaim[];
  removedClaimIds: string[];
  chapterMemory: ChapterMemory;
}

export class ChapterStateRebuildService {
  constructor(private readonly deps: {
    repository: ChapterStateRebuildRepositoryAccess;
    objects: ObjectStoreAdapter;
    model: ModelGateway;
    skillProvider: SkillProvider;
    memoryIndex?: MemoryIndex;
    routingSnapshot?: ModelRoutingSnapshot;
  }) {}

  async rebuildCommittedChapterState(projectId: string, documentId: string, actorId: string): Promise<RebuildCommittedChapterStateResult> {
    if (!actorId.trim()) throw new Error("actorId 必填");
    const source = await this.deps.repository.getFinalDocumentContentRef(projectId, documentId);
    if (!source) throw new Error("章节不存在");
    if (source.status !== "final" || !source.sourceRevisionId || !source.objectKey || !source.contentHash) throw new Error("只能重建已有正式 revision 的章节状态");
    await this.deps.repository.assertChapterStateRebuildHead(projectId, documentId, source.sourceRevisionId);

    const text = await this.deps.objects.getText(source.objectKey);
    const workflowId = `chapter-state-rebuild:${documentId}:${randomUUID()}`;
    const factArtifact: Artifact = {
      id: randomUUID(),
      projectId,
      taskId: `${workflowId}:facts`,
      attemptId: `${workflowId}:facts:attempt-1`,
      kind: "fact-extraction",
      contentHash: source.contentHash,
      objectKey: source.objectKey,
      baseRevision: source.revision,
      fingerprint: createHash("sha256").update(`${source.sourceRevisionId}:${source.contentHash}:${workflowId}`).digest("hex"),
      structuredData: { origin: "committed-chapter-state-rebuild", sourceArtifactId: source.artifactId, documentId, revisionId: source.sourceRevisionId, workflowId, actorId },
      createdAt: Date.now(),
    };
    const extractionContext = await this.deps.repository.getFactExtractionContext(projectId, source.narrativeOrder - 1);
    const skillBundle = await resolveStageSkillBundle({ projectId, provider: this.deps.skillProvider, executionPoint: "chapter.fact-extraction", role: "fact-extractor", preflightId: workflowId });
    // 与 extractFacts activity 同一身份契约：prompt 名册 + 提取结果归一（读取失败降级为无归一）。
    let identityContext: { identityIndex: CharacterIdentityIndex; canonicalCharacters: Array<{ canonicalId: string; displayName: string }> } | undefined;
    try {
      const registry = await loadCharacterIdentityRegistry(projectId, this.deps.repository);
      identityContext = {
        identityIndex: registry.index,
        canonicalCharacters: uniqueCharacterIdentities(registry.index)
          .filter((identity) => identity.status === "identified")
          .map((identity) => ({ canonicalId: identity.canonicalId, displayName: identity.displayName })),
      };
    } catch (error) {
      console.warn(`[chapter-state-rebuild] 人物身份注册表加载失败，本次重建退回无归一模式：${(error as Error).message}`);
    }
    const extracted = await extractFactsWithStats({
      projectId,
      artifact: factArtifact,
      text,
      model: this.deps.model,
      existingClaimsDigest: extractionContext.claimsDigest,
      existingContentHashes: extractionContext.contentHashes,
      existingClaimsIndex: extractionContext.claimsIndex,
      existingValueHashById: extractionContext.valueHashById,
      narrativeOrder: source.narrativeOrder,
      routingSnapshot: this.deps.routingSnapshot,
      workflowRunId: workflowId,
      taskId: factArtifact.taskId,
      skillBundle,
      identityIndex: identityContext?.identityIndex,
      canonicalCharacters: identityContext?.canonicalCharacters,
    });
    const chapterMemorySkills = await resolveStageSkillBundle({ projectId, provider: this.deps.skillProvider, executionPoint: "chapter.fact-extraction", role: "fact-extractor", preflightId: `${workflowId}:chapter-memory` });
    const chapterMemoryOutput = await generateChapterMemoryOutput({
      projectId,
      documentId,
      revisionId: source.sourceRevisionId,
      narrativeOrder: source.narrativeOrder,
      text,
      artifact: factArtifact,
      model: this.deps.model,
      routingSnapshot: this.deps.routingSnapshot,
      workflowRunId: workflowId,
      taskId: `${factArtifact.taskId}:chapter-memory`,
      skills: chapterMemorySkills,
    }, { repository: this.deps.repository });

    await this.deps.repository.recordFactExtraction({ projectId, artifact: factArtifact, claims: extracted.claims, lifecycleStatus: "staged", documentId, workflowId, narrativeOrder: source.narrativeOrder });
    await this.deps.repository.recordFactApprovalPolicy({ projectId, artifactId: factArtifact.id, workflowId });
    const chapterMemory = buildChapterMemoryProjection({ projectId, documentId, revisionId: source.sourceRevisionId, narrativeOrder: source.narrativeOrder }, chapterMemoryOutput);
    const claimSwap = await this.deps.repository.applyCommittedChapterStateRebuild({
      projectId,
      documentId,
      revisionId: source.sourceRevisionId,
      factArtifactId: factArtifact.id,
      actorId,
      artifact: factArtifact,
      narrativeOrder: source.narrativeOrder,
      narrativeElements: extracted.narrativeElements,
      chapterMemory,
    });

    let rollupClaim: MemoryClaim | undefined;
    try {
      rollupClaim = await this.deps.repository.refreshChapterMemoryRollup(projectId, source.narrativeOrder);
    } catch (error) {
      await this.recordProjectionFailure(projectId, source.sourceRevisionId, "chapter-memory-rollup", error);
    }
    if (this.deps.memoryIndex) {
      try {
        if (claimSwap.removedClaimIds.length) await this.deps.memoryIndex.deleteClaims?.(projectId, claimSwap.removedClaimIds);
        await this.deps.memoryIndex.upsertClaims(projectId, [
          ...claimSwap.activatedClaims,
          chapterMemoryAsClaim(chapterMemory),
          ...(rollupClaim ? [rollupClaim] : []),
        ]);
      } catch (error) {
        await this.recordProjectionFailure(projectId, source.sourceRevisionId, "memory-index", error);
      }
    }
    // staged 残骸对账（FM-2 修复③）：grooming 有诊断能力但缺自动触发，这里补上
    // 精确同文残骸的清理钩子；失败显式记录，不影响已成功的重建结果。
    try {
      await this.deps.repository.reconcileStagedClaimDebris(projectId, documentId);
    } catch (error) {
      await this.recordProjectionFailure(projectId, source.sourceRevisionId, "staged-debris-reconcile", error);
    }
    return { projectId, documentId, revisionId: source.sourceRevisionId, factArtifactId: factArtifact.id, chapterMemory, ...claimSwap };
  }

  private async recordProjectionFailure(projectId: string, revisionId: string, projectionType: string, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[chapter-state-rebuild] ${projectionType} 投影失败，可从 PostgreSQL 重建：${message}`);
    await this.deps.repository.recordProjectionFailure({
      projectId,
      projectionType: `chapter-state-rebuild:${projectionType}`,
      aggregateId: revisionId,
      payload: { revisionId },
      error: message,
    }).catch((recordError) => console.warn(`[chapter-state-rebuild] 投影失败记录写入失败：${(recordError as Error).message}`));
  }
}
