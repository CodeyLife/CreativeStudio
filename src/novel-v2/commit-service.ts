import { randomUUID } from "node:crypto";
import type { ChapterMemory, CommitRequest, CommitResult, RuntimeLearningAssessmentV2, SkillBundle } from "./protocol";
import type { CommitServiceRepositoryAccess } from "./repository-capabilities";
import { ContentObjectStore, type ObjectStoreAdapter } from "./object-store";
import type { ModelGateway } from "./model-gateway";
import type { ModelRoutingSnapshot } from "./model-routing";
import type { MemoryIndex } from "./qdrant-memory";
import { createChapterMemoryFromRevision } from "./chapter-memory";
import { writeMemoryIndexWithTrace } from "./memory-index-drift";
import { evaluateCommitGate } from "./temporal/revision-policy";
import type { FactExtractionOutput } from "./prompts/schemas";
import { inspectManuscript, type ManuscriptStructuralReport } from "./application/manuscript-structure";
import { countNovelCharacters } from "./word-count";

type CommitDerivedData = {
  structuralReport: ManuscriptStructuralReport;
  narrativeElements?: FactExtractionOutput["narrativeElements"];
  narrativeOrder?: number;
  factArtifactId?: string;
  chapterMemorySkills?: SkillBundle;
};

/**
 * V2 Commit Service：负责章节定稿提交 + chapter memory 创建。
 *
 * 设计依据：AGENTS.md「commit-stage 对新 DocumentRevision 创建 chapter memory」契约。
 *
 * 流程：
 * 1. 三类审核：必须具备当前 artifact 的全部角色通过证据
 * 2. 写入 objectStore（正文落盘）
 * 3. commitRevision：写入 manuscript_revisions + 推进 current_revision + 写 idempotency_keys
 * 4. createChapterMemoryFromRevision：从定稿正文提取章节记忆（summary/keyEvents/...）
 *    - 失败不阻塞 commit（revision 已落库），只记录错误让上游 learning 闭环感知
 *    - 符合 AGENTS.md「不阻塞 commit」契约
 *
 * chapter memory 依赖注入（可选）：
 * - model + routingSnapshot + memoryIndex 都提供时，启用 chapter memory 创建
 * - 缺失时跳过（向后兼容，如测试环境无 LLM/Qdrant 时仍可 commit）
 */
export interface ChapterMemoryDeps {
  model: ModelGateway;
  memoryIndex?: MemoryIndex;
  /** 默认 routingSnapshot（commit activity 不传 routingSnapshot 时用此值）。 */
  defaultRoutingSnapshot?: ModelRoutingSnapshot;
  workflowRunId?: string;
  /** 章节顺序号（若提供，直接用；否则从 repository 查 manuscript_documents.narrative_order）。 */
  narrativeOrder?: number;
}

export class CommitService {
  constructor(
    private readonly repository: CommitServiceRepositoryAccess,
    private readonly objects: ObjectStoreAdapter = new ContentObjectStore(),
    /** 可选的 chapter memory 依赖。缺失时 commit 不创建 chapter memory（向后兼容）。 */
    private readonly chapterMemoryDeps?: ChapterMemoryDeps,
  ) {}

  async commit(input: CommitRequest & { text: string } & CommitDerivedData): Promise<CommitResult & { chapterMemory?: ChapterMemory }> {
    // 目标篇幅是蓝图里的已冻结事实，由本服务自取而非由调用方申报（"可推导事实不留裁量权"，
    // 与 evaluateCommitGate 的篇幅判据同因：两次重出的骨架稿曾全绿过审）。仓储返回的是
    // **有效目标**（蓝图声明优先、缺省回落 DEFAULT，与 draft prompt 播报同一个数）；只有
    // 本章无章节蓝图或读取失败才是 undefined——门不替系统从没承载过该章的场合发明目标。
    // 能力接口外的桩缺此方法时显式 warn，不静默放宽门。
    const reader = this.repository.getChapterTargetWordCount;
    let targetWordCount: number | undefined;
    if (typeof reader === "function") {
      try {
        targetWordCount = await reader.call(this.repository, input.projectId, input.documentId);
      } catch (error) {
        console.warn(`[commit-service] 本章目标篇幅读取失败，本轮跳过篇幅门：${error instanceof Error ? error.message : String(error)}`);
      }
    } else {
      console.warn("[commit-service] 仓储未提供 getChapterTargetWordCount，篇幅门未施加（生产装配缺失，须修接线）");
    }
    const gate = evaluateCommitGate(input.reviews, input.artifact.fingerprint, input.structuralReport, input.changeScope, { plainTextLength: countNovelCharacters(input.text), targetWordCount });
    if (!gate.passed) throw new Error(`正式提交必须具备当前 artifact 的完整三类 reviewer 通过证据（changeScope=${input.changeScope ?? "narrative"} 档位，质量失败=${gate.qualityFailure ?? "无"}）；缺失角色：${gate.missingRoles.join("、") || "无"}`);
    if (!inspectManuscript({ text: input.text }).passed) throw new Error("正式提交正文未通过确定性结构复检");
    return this.persistApprovedRevision(input);
  }

  /** Commit a manuscript only after an explicit durable author approval signal. */
  async commitAuthorApproved(input: CommitRequest & { text: string; approvalEvidenceId: string } & CommitDerivedData): Promise<CommitResult & { chapterMemory?: ChapterMemory }> {
    if (!input.structuralReport.passed || !inspectManuscript({ text: input.text }).passed) throw new Error("作者覆盖不能越过正文结构 blocker");
    const evidence = await this.repository.getApprovalEvidenceById(input.approvalEvidenceId);
    if (!evidence
      || evidence.projectId !== input.projectId
      || evidence.artifactId !== input.artifact.id
      || evidence.decision !== "approve"
      || evidence.actorSource !== "interactive-web") {
      throw new Error("作者批准提交必须绑定当前项目和 artifact 的 interactive-web 批准证据");
    }
    return this.persistApprovedRevision(input);
  }

  private async persistApprovedRevision(input: CommitRequest & { text: string } & CommitDerivedData): Promise<CommitResult & { chapterMemory?: ChapterMemory }> {
    const object = await this.objects.putText(input.text);
    const result = await this.repository.commitRevision({ ...input, contentHash: object.hash, objectKey: object.key, revisionId: randomUUID() });

    if (this.chapterMemoryDeps?.memoryIndex) {
      const retrievable = (result.activatedClaims ?? []).filter((claim) => ["approved", "author", "derived"].includes(claim.authority));
      // 不阻塞 + 留痕走共享包膜（memory-index-drift.ts 的 writeMemoryIndexWithTrace）：
      // 此前这里只 console.warn，与同函数内 narrative-elements / narrative-state-snapshot
      // 两个失败点不同形。代价见 state-audit §8.4——chapter-memory 的索引失败同样只 warn，
      // 运行库实测 6 条章记忆"在一切查询里都显得完全活着，只有语义检索永远召不回它"，
      // 静默数周，唯一暴露途径是 doctor 的漂移检查，而它按设计不自动触发。
      await writeMemoryIndexWithTrace({
        projectId: input.projectId,
        aggregateId: result.revisionId,
        projectionType: "memory-index",
        rowIds: [...(result.removedClaimIds ?? []), ...retrievable.map((claim) => claim.id)],
        write: async () => {
          if (result.removedClaimIds?.length) await this.chapterMemoryDeps!.memoryIndex!.deleteClaims?.(input.projectId, result.removedClaimIds);
          if (retrievable.length) await this.chapterMemoryDeps!.memoryIndex!.upsertClaims(input.projectId, retrievable);
        },
        record: (failure) => this.repository.recordProjectionFailure(failure),
      });
    }

    if (input.narrativeElements) {
      try {
        await this.repository.recordNarrativeElements({
          projectId: input.projectId,
          documentId: input.documentId,
          artifact: input.artifact,
          revisionId: result.revisionId,
          narrativeOrder: input.narrativeOrder,
          narrativeElements: input.narrativeElements,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[commit-service] 叙事元素写入失败（正文 revision 已提交）：${message}`);
        await this.repository.recordProjectionFailure({
          projectId: input.projectId,
          projectionType: "narrative-elements",
          aggregateId: result.revisionId,
          payload: { documentId: input.documentId, artifactId: input.artifact.id, revisionId: result.revisionId, narrativeOrder: input.narrativeOrder, narrativeElements: input.narrativeElements },
          error: message,
        }).catch((recordError) => console.warn(`[commit-service] 投影失败记录写入失败：${(recordError as Error).message}`));
      }
    }

    // chapter memory 创建：失败不阻塞 commit（revision 已落库），记录到 learning 闭环
    // 设计依据：AGENTS.md「不阻塞 commit」契约 + Phase 1.2 chapter memory 闭环
    // 失败处理：构造 RuntimeLearningAssessmentV2(conclusion=no-shared-learning) 让 learning 闭环感知症状
    let chapterMemory: ChapterMemory | undefined;
    if (this.chapterMemoryDeps) {
      try {
        const narrativeOrder = this.chapterMemoryDeps.narrativeOrder ?? await this.lookupNarrativeOrder(input.projectId, input.documentId);
        const memoryInput = {
            projectId: input.projectId,
            documentId: input.documentId,
            revisionId: result.revisionId,
            narrativeOrder,
            text: input.text,
            artifact: input.artifact,
            skills: input.chapterMemorySkills,
        };
        chapterMemory = await createChapterMemoryFromRevision(
          {
            ...memoryInput,
            model: this.chapterMemoryDeps.model,
            routingSnapshot: this.chapterMemoryDeps.defaultRoutingSnapshot,
            workflowRunId: this.chapterMemoryDeps.workflowRunId,
            taskId: `${input.artifact.taskId}:chapter-memory`,
          },
          { repository: this.repository, objects: this.objects, memoryIndex: this.chapterMemoryDeps.memoryIndex },
        );
      } catch (error) {
        // chapter memory 创建失败：记录到 learning 闭环（conclusion=no-shared-learning，仅 symptom 不构造 candidate）
        // 设计依据：AGENTS.md「review-stage → learning 通路」契约——审核结果必须反馈到 learning
        await this.recordChapterMemoryFailure(input, result.revisionId, error instanceof Error ? error : new Error(String(error)));
      }
    }
    if (chapterMemory) {
      try {
        const narrativeOrder = input.narrativeOrder ?? chapterMemory.narrativeRange.end;
        await this.repository.recordNarrativeStateSnapshot({
          projectId: input.projectId,
          documentId: input.documentId,
          revisionId: result.revisionId,
          narrativeOrder,
          chapterMemory,
          narrativeElements: input.narrativeElements,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[commit-service] 叙事状态账本写入失败（正文 revision 已提交，可重建）：${message}`);
        await this.repository.recordProjectionFailure({
          projectId: input.projectId,
          projectionType: "narrative-state-snapshot",
          aggregateId: result.revisionId,
          payload: { documentId: input.documentId, revisionId: result.revisionId, narrativeOrder: input.narrativeOrder },
          error: message,
        }).catch((recordError) => console.warn(`[commit-service] 叙事账本投影失败记录写入失败：${(recordError as Error).message}`));
      }
    }
    return chapterMemory ? { ...result, chapterMemory } : result;
  }

  /**
   * 把 chapter memory 创建失败记录为 RuntimeLearningAssessmentV2。
   *
   * 设计依据：AGENTS.md「review-stage → learning 通路」契约——
   * 不允许审核/提取结果只写入 qualityReport 而不反馈到 learning。
   * chapter memory 失败属于 fact-extraction 层故障，记录 symptom + failingLayer
   * 让 learning 闭环感知（conclusion=no-shared-learning 表示不构造 candidate，
   * 仅作为运行时症状留痕，供后续 propose-improvement 分析使用）。
   */
  private async recordChapterMemoryFailure(input: CommitRequest & { text: string }, revisionId: string, error: Error): Promise<void> {
    const message = error.message || String(error);
    console.warn(`[commit-service] chapter memory 创建失败（不阻塞 commit）：${message}`);
    try {
      const assessment: RuntimeLearningAssessmentV2 = {
        id: `learning:chapter-memory-failure:${revisionId}`,
        projectId: input.projectId,
        source: {
          workflowId: this.chapterMemoryDeps?.workflowRunId ?? "commit-service",
          artifactId: input.artifact.id,
          reviewIds: input.reviews.map((review) => review.id),
          fingerprint: input.artifact.fingerprint,
        },
        conclusion: "no-shared-learning",
        symptom: `chapter memory 创建失败：${message}`,
        failingLayer: "commit-stage.chapter-memory",
        createdAt: Date.now(),
      };
      await this.repository.recordLearningAssessment(assessment);
    } catch (recordError) {
      // learning 记录失败不应再掩盖原始 commit 成功，只警告
      console.warn(`[commit-service] learning 记录失败：${(recordError as Error).message}`);
    }
  }

  /**
   * 查询章节顺序号（manuscript_documents.narrative_order）。
   *
   * 用于 chapter memory 的 narrativeRange 字段。
   */
  private async lookupNarrativeOrder(projectId: string, documentId: string): Promise<number> {
    const narrativeOrder = await this.repository.getDocumentNarrativeOrder(projectId, documentId);
    if (narrativeOrder === undefined) throw new Error(`章节不存在：${documentId}`);
    return narrativeOrder;
  }
}
