/**
 * 仓储消费面能力表（slice 拆分的第一步：先把"谁真的需要什么"变成可检查的类型）。
 *
 * 根因（度量得，非印象）：34 个文件把整个 `NovelPostgresRepository` 当依赖，其中只有
 * 1 个用了本仓既有的 `Pick<NovelPostgresRepository, …>` 接缝写法。更关键的是**8 个文件
 * 只用 `repository.pool`**——它们要的是"一条 SQL 通道"，却要了整个 god-object 的类型面。
 * 这一条决定了拆类的先后：`pool` 是 public 的时候，把类切成 slices 不会降低任何耦合，
 * 因为原始 SQL 消费方要的从来不是领域方法。所以先立边界，再谈搬迁。
 *
 * 用法约定：
 * - 消费方声明自己所属的能力类型，构造侧照旧传完整 repository（结构类型，零运行时改动）；
 *   tsc 就是"这份清单是否漏项"的判据，漏了直接编译不过。
 * - `RepositoryQueryClient` 是**连接面**，不是领域能力：只允许 `pool`。给它加任何领域方法
 *   等于把 slice 边界又焊回 god-object，守卫测试会红。真要领域方法就另立能力类型。
 * - 能力类型是将来物理拆分的切线：同一批方法反复出现在多个类型里，就是那一片该独立成
 *   仓储的 signal（例如 workflow run 写入面同时出现在三个工作流应用能力里）。
 */
import type { NovelPostgresRepository } from "./postgres-repository";

/** 连接面：只要一条 SQL 通道，不依赖任何领域方法。 */
export type RepositoryQueryClient = Pick<NovelPostgresRepository, "pool">;

/**
 * 模型运行时装配：路由配置读取 + 调用/提示留痕 + 嵌入缓存端口。
 * `lookupEmbeddings/storeEmbeddings` 不在本文件的调用点上，而是把 repository 原样交给
 * 网关构造器的 `EmbeddingCachePort` 形参（OR-D2）——能力清单必须覆盖**传递出去的需求**，
 * 否则收窄就是在撒谎（tsc 会在此处拦下）。
 */
export type ModelRuntimeRepositoryAccess = Pick<
  NovelPostgresRepository,
  "projectModelRoutingConfig" | "recordModelInvocation" | "recordPromptExecution" | "lookupEmbeddings" | "storeEmbeddings"
>;

/** 对象存储身份守卫。 */
export type RuntimeObjectStoreGuardAccess = Pick<NovelPostgresRepository, "assertRuntimeObjectStoreIdentity" | "listReferencedObjectKeys">;

/** 章节记忆读写。 */
export type ChapterMemoryRepositoryAccess = Pick<NovelPostgresRepository, "createChapterMemory" | "getChapterMemories" | "refreshChapterMemoryRollup">;

/** 角色富化：事实提取写入 + 连接面（回退查询）。 */
export type CharacterEnrichmentRepositoryAccess = Pick<NovelPostgresRepository, "pool" | "recordFactExtraction">;

/** 提交链路：修订落库、叙事面记录，以及提交后同步章节记忆（向 chapter-memory 透传）。 */
export type CommitServiceRepositoryAccess = Pick<
  NovelPostgresRepository,
  "commitRevision" | "createChapterMemory" | "getApprovalEvidenceById" | "getChapterMemories" | "getDocumentNarrativeOrder" | "recordLearningAssessment" | "recordNarrativeElements" | "recordNarrativeStateSnapshot" | "recordProjectionFailure" | "refreshChapterMemoryRollup"
>;

/** 作品简介工作流。 */
export type BookSynopsisWorkflowRepositoryAccess = Pick<
  NovelPostgresRepository,
  "getProjectDetail" | "listProjectPlanSections" | "listProjectRuns" | "putWorkflowRun" | "updateWorkflowRunStatus"
>;

/** 章节命名工作流。 */
export type ChapterTitleWorkflowRepositoryAccess = Pick<
  NovelPostgresRepository,
  "getChapterTitleSource" | "listProjectRuns" | "putWorkflowRun" | "updateWorkflowRunStatus"
>;

/** 项目初始化引导：bootstrap run 幂等 + 规划初始化 + run 写入（含向 work-item/连接面透传的需求）。 */
export type BootstrapRepositoryAccess = Pick<
  NovelPostgresRepository,
  "findBootstrapRunId" | "getFoundationWorkContext" | "initializeProjectPlan" | "putWorkflowRun" | "pool" | "getProjectPlanSection" | "listProjectPlanSections"
>;

/** 章节剧本直出：正文读取 + 产物写入 + 连接面。 */
export type ChapterScriptRepositoryAccess = Pick<NovelPostgresRepository, "getArtifact" | "getFinalDocumentContentRef" | "pool" | "recordArtifact">;

/**
 * 创作指令路由：记录读写 + 连接面 + 工作项编排面。
 * 后两个方法不在本文件调用点上——它把 repository 继续传给 work-item 的编排函数，
 * 能力清单必须含传递出去的需求。
 */
export type CommandRouterRepositoryAccess = Pick<
  NovelPostgresRepository,
  "approveProjectPlanSection" | "getRecord" | "pool" | "getProjectPlanSection" | "listProjectPlanSections"
>;

/** 工作项编排：规划面读取 + 连接面。 */
export type WorkItemRepositoryAccess = Pick<NovelPostgresRepository, "getProjectPlanSection" | "listProjectPlanSections" | "pool">;

/** 故事弧工作流编排（run 写入面 + 弧批次面）。 */
export type StoryArcWorkflowRepositoryAccess = Pick<
  NovelPostgresRepository,
  "createNextStoryArc" | "failStoryArcBatch" | "getStoryArc" | "listActiveStoryArcWorkflowIds" | "markStoryArcGenerating" | "prepareNextStoryArcBatch" | "prepareStoryArcBatchRetry" | "prepareStoryArcRebase" | "prepareStoryArcReviewRetry" | "putWorkflowRun" | "recoverStoryArcAfterWorkflowCancellation" | "updateWorkflowRunStatus" | "withStoryArcWorkflowLock"
>;

/** 章节状态重建（事实面读写 + 投影收尾 + 向富化/章节记忆模块透传的需求）。 */
export type ChapterStateRebuildRepositoryAccess = Pick<
  NovelPostgresRepository,
  "applyCommittedChapterStateRebuild" | "assertChapterStateRebuildHead" | "createChapterMemory" | "getChapterMemories" | "getFactExtractionContext" | "getFinalDocumentContentRef" | "pool" | "reconcileStagedClaimDebris" | "recordFactApprovalPolicy" | "recordFactExtraction" | "recordProjectionFailure" | "refreshChapterMemoryRollup"
>;
