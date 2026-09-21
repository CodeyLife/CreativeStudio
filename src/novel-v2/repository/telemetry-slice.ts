/**
 * 调用留痕与观测面 slice（第三片物理拆分）。
 *
 * 度量决定的边界：这 12 个方法只写 `model_invocations` / `prompt_executions` /
 * `context_manifests` / `embedding_cache` 四张**只增不改**的观测表，簇内除 `this.pool`
 * 之外零协作者（唯一内部调用指向同片的 `putPromptContextManifest`），也不落 outbox——
 * 是前三次度量里最干净的一片。与之相反，审批链路（claimApprovalEvidence 等）一次事务
 * 动 4 张表，那是跨片编排而非一片，硬搬只会把别处的表拖进这个文件。
 *
 * 为什么单独成片有实际收益而不只是整洁：估算口径合并（token basis）要读的正是这批表，
 * `getEstimatedVsProviderRatio` / `recordPromptExecution` 双口径三元组将来都落在本文件，
 * 留痕与报表读写有单一归属地才能独立演进与独立测。
 *
 * 边界（刻意不含，三个跨片编排留在仓储，归属锁逐个点名）：`cleanupExpiredPromptExecutions`
 * 同时动内容存储（content_blobs / snapshots）；`deleteProject` 是项目级联删除；
 * `putCognition` 一次落 preflight/memory/skill/blueprint/manifest 整组认知包。它们的写入面
 * 天然横跨多片，硬搬会把别处的表拖进观测片。
 */
import type { Pool } from "pg";
import type { ModelInvocationAudit, ModelPromptExecution } from "../model-gateway";
import type { ObjectStoreAdapter } from "../object-store";
import type { PromptContextManifest } from "../protocol";
import { contextManifestSamplingHit, samplingRatioFromEnv } from "../context-manifest-sampling";
import { embeddingFingerprint } from "../model-gateway";
import { randomUUID } from "node:crypto";
import { iso } from "./shared";

/**
 * 执行留痕的默认保留天数（`NOVEL_PROMPT_RETENTION_DAYS`，缺省 30）。
 * 单一来源：写入侧据此逐行算 `prompt_executions.expires_at`，报表的 `sinceDays` 缺省同引它。
 * 每次调用现读环境变量（进程内改配置能影响之后写入的行）。
 *
 * 行为差异如实登记：改前 `Math.max(1, Number(env ?? 30))` 会把 `0` 夹成 1 天、把非法值
 * 变成 NaN 再落进 SQL；现在 `0` 与非法值一律回落到缺省 30（"保留 0 天"不是有效配置，
 * 而 NaN 会让整批写入抛错）。运行库现值就是缺省 30，本改动不影响既有行。
 */
export const promptExecutionRetentionDays = (): number => Math.max(1, Number(process.env.NOVEL_PROMPT_RETENTION_DAYS ?? 30) || 30);

export class TelemetrySlice {
  constructor(private readonly pool: Pool) {}

  async recordModelInvocation(input: ModelInvocationAudit): Promise<void> {
    await this.pool.query(
      `INSERT INTO model_invocations(workflow_run_id,task_id,purpose,config_revision,candidate_index,executor,profile_id,provider_label,protocol,model,status,input_tokens,output_tokens,provider_input_tokens,provider_output_tokens,provider_cached_input_tokens,estimated_input_tokens,estimated_output_tokens,usage_source,latency_ms,prompt_fingerprint,response_id,error_category,error_message,project_id)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,COALESCE($25::text, (SELECT r.project_id FROM workflow_runs r WHERE r.id=$1 OR r.temporal_workflow_id=$1 LIMIT 1)))`,
      [input.workflowRunId ?? null, input.taskId ?? null, input.purpose, input.configRevision, input.candidateIndex, input.executor, input.profileId ?? null, input.providerLabel ?? null, input.protocol ?? null, input.model, input.status, input.inputTokens, input.outputTokens, input.providerInputTokens ?? null, input.providerOutputTokens ?? null, input.providerCachedInputTokens ?? null, input.estimatedInputTokens ?? null, input.estimatedOutputTokens ?? null, input.usageSource ?? "provider", input.latencyMs, input.promptFingerprint, input.responseId ?? null, input.errorCategory ?? null, input.errorMessage?.slice(0, 2_000) ?? null, input.projectId ?? null],
    );
  }

  async listModelUsage(limit = 100) {
    const result = await this.pool.query(
      `SELECT purpose,profile_id,protocol,model,status,usage_source,COUNT(*)::int AS calls,COALESCE(SUM(input_tokens),0)::bigint AS input_tokens,COALESCE(SUM(output_tokens),0)::bigint AS output_tokens,COALESCE(SUM(provider_input_tokens),0)::bigint AS provider_input_tokens,COALESCE(SUM(provider_output_tokens),0)::bigint AS provider_output_tokens,COALESCE(SUM(provider_cached_input_tokens),0)::bigint AS provider_cached_input_tokens,COALESCE(SUM(estimated_input_tokens),0)::bigint AS estimated_input_tokens,COALESCE(SUM(estimated_output_tokens),0)::bigint AS estimated_output_tokens,COALESCE(AVG(latency_ms),0)::int AS average_latency_ms
       FROM model_invocations GROUP BY purpose,profile_id,protocol,model,status,usage_source ORDER BY MAX(created_at) DESC LIMIT $1`,
      [limit],
    );
    return result.rows;
  }

  /**
   * OR-D3（product-audit-20260910 E5 剩余子项）：估算 vs provider 上报的按 purpose
   * 只读比值报表。症状：估算与上报差最高 76 倍且只能人工抓样本——tokenizer 漂移
   * （估算公式对特定模型系统性偏低/偏高）不可见、不可回归。
   * 机制：仅统计双列都非空的行（provider 未上报的行不参与比值，防把"缺报"读成
   * "偏差"）；p50/p95 用分位数而非均值——单条超长调用不应拉爆整体判断；
   * max_ratio 行定位最坏样本。泛化：无 purpose/model 专属分支，任何 provider 接入
   * 即入报表。sinceDays 缺省值与留痕载荷寿命同源（见 promptExecutionRetentionDays）。
   */
  async getEstimatedVsProviderRatio(input: { sinceDays?: number } = {}) {
    // 诊断窗口默认值与留痕载荷的寿命同源（同一个"30 天"约定，两处不再各写一份字面量）。
    // 刻意不做夹紧：行与 context_manifest_id 都活得比载荷久（清理只置 NULL 载荷），
    // 报表请求更长的窗口不是"读不到"，只是"更老的那段没有收据以外的证据"。
    const sinceDays = input.sinceDays ?? promptExecutionRetentionDays();
    const result = await this.pool.query<{
      purpose: string; model: string; comparable_calls: number; artifact_calls: number;
      p50_ratio: number | null; p95_ratio: number | null; max_ratio: number | null; min_ratio: number | null;
      manifest_linked_calls: number;
    }>(
      // 比率只用"provider 对整份负载的真实上报"：与同一请求的独立估算偏离两个
      // 数量级以上（provider_input*100 < estimated）判为非测量——占位 1/1、只报
      // 增量/未展开缓存等协议形态都落在此带内（真实分词器口径差异只在数倍内，
      // 不误伤真·小调用：est=1 上报 1 仍可比）。伪测量混入会把 p50 拉塌到 1e-4，
      // 恰摧毁本报表"检测估算器偏差"的目的。被剔行不静默丢账：artifact_calls
      // 显式计数，占比本身是 provider 上报质量的观测面。
      `SELECT purpose, model,
         COUNT(*) FILTER (WHERE NOT (provider_input_tokens * 100 < estimated_input_tokens))::int AS comparable_calls,
         COUNT(*) FILTER (WHERE provider_input_tokens * 100 < estimated_input_tokens)::int AS artifact_calls,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY (CASE WHEN provider_input_tokens * 100 < estimated_input_tokens THEN NULL ELSE provider_input_tokens::numeric / estimated_input_tokens END)) AS p50_ratio,
         percentile_cont(0.95) WITHIN GROUP (ORDER BY (CASE WHEN provider_input_tokens * 100 < estimated_input_tokens THEN NULL ELSE provider_input_tokens::numeric / estimated_input_tokens END)) AS p95_ratio,
         MAX(provider_input_tokens::numeric / estimated_input_tokens) FILTER (WHERE NOT (provider_input_tokens * 100 < estimated_input_tokens)) AS max_ratio,
         MIN(provider_input_tokens::numeric / estimated_input_tokens) FILTER (WHERE NOT (provider_input_tokens * 100 < estimated_input_tokens)) AS min_ratio,
         COUNT(*) FILTER (WHERE EXISTS (
           SELECT 1 FROM prompt_executions pe
           WHERE pe.prompt_fingerprint = model_invocations.prompt_fingerprint AND pe.context_manifest_id IS NOT NULL
         ))::int AS manifest_linked_calls
       FROM model_invocations
       WHERE created_at > now() - ($1::int * interval '1 day')
         AND estimated_input_tokens > 0 AND provider_input_tokens IS NOT NULL
       GROUP BY purpose, model ORDER BY comparable_calls DESC`,
      [sinceDays],
    );
    return result.rows.map((row) => ({
      purpose: row.purpose,
      model: row.model,
      comparableCalls: row.comparable_calls,
      artifactCalls: row.artifact_calls,
      p50Ratio: row.p50_ratio === null ? null : Number(row.p50_ratio),
      p95Ratio: row.p95_ratio === null ? null : Number(row.p95_ratio),
      maxRatio: row.max_ratio === null ? null : Number(row.max_ratio),
      minRatio: row.min_ratio === null ? null : Number(row.min_ratio),
      manifestLinkedCalls: row.manifest_linked_calls,
    }));
  }

  /**
   * OR-A1（product-audit-20260910 E1）跨 purpose 候选健康度诊断——泛化谓词，不绑定具体
   * 书名/人物/某条历史坏路由：按 `(purpose,candidate_index,executor,profile_id,provider_label,model)`
   * 聚合调用，样本数≥阈值且成功数=0 ⇒ 判"从未成功"（建议摘除/降权）；同时把"失败等待墙钟"
   * （SUM(latency_ms) where status='failed'）提为常规聚合指标，暴露烧在死路由上的时间。
   * 只读诊断不改运行时行为——运维挪路由与机制诊断分离，防"改完配置又腐烂"。
   * minSamples 阈值防小样本误判（单次失败 ≠ 死路由）；跨所有 purpose/候选一次性给出。
   */
  async getRoutingCandidateHealth(input: { sinceDays?: number; minSamples?: number } = {}) {
    const sinceDays = input.sinceDays ?? 30; // TODO P3: 窗口应可配置（诊断默认近 30 天）
    const minSamples = input.minSamples ?? 5; // TODO P3: 死路由判定最小样本，防偶发单点失败误判
    const result = await this.pool.query<{
      purpose: string; candidate_index: number; executor: string; profile_id: string | null; provider_label: string | null; model: string;
      calls: number; failures: number; never_succeeded: boolean;
      failed_wallclock_ms: string; total_wallclock_ms: string;
    }>(
      `SELECT purpose, candidate_index, executor, profile_id, provider_label, model,
        COUNT(*)::int AS calls,
        COUNT(*) FILTER (WHERE status='failed')::int AS failures,
        (COUNT(*) FILTER (WHERE status='completed')=0 AND COUNT(*) >= $1::int) AS never_succeeded,
        COALESCE(SUM(latency_ms) FILTER (WHERE status='failed'),0)::bigint AS failed_wallclock_ms,
        COALESCE(SUM(latency_ms),0)::bigint AS total_wallclock_ms
       FROM model_invocations
       WHERE created_at >= now() - make_interval(days => $2::int)
       GROUP BY purpose, candidate_index, executor, profile_id, provider_label, model
       ORDER BY never_succeeded DESC, failed_wallclock_ms DESC`,
      [minSamples, sinceDays],
    );
    return result.rows.map((row) => ({
      purpose: row.purpose,
      candidateIndex: row.candidate_index,
      executor: row.executor,
      profileId: row.profile_id,
      providerLabel: row.provider_label,
      model: row.model,
      calls: row.calls,
      failures: row.failures,
      neverSucceeded: row.never_succeeded,
      failedWallClockMs: Number(row.failed_wallclock_ms),
      totalWallClockMs: Number(row.total_wallclock_ms),
    }));
  }

  /**
   * OR-D2（product-audit-20260910 E5）嵌入幂等短路的持久实现（EmbeddingCachePort）：
   * 键=embeddingFingerprint(model,text)，同模型同内容全局复用（向量无项目归属，
   * 项目隔离由 Qdrant payload 承担）。lookup 顺序与入参 texts 一一对应。
   */
  async lookupEmbeddings(model: string, texts: string[]): Promise<(number[] | undefined)[]> {
    if (!texts.length) return [];
    const fingerprints = texts.map((text) => embeddingFingerprint(model, text));
    const result = await this.pool.query<{ prompt_fingerprint: string; vector: number[] }>(
      "SELECT prompt_fingerprint, vector FROM embedding_cache WHERE prompt_fingerprint = ANY($1::text[])",
      [fingerprints],
    );
    const byFingerprint = new Map(result.rows.map((row) => [row.prompt_fingerprint, row.vector]));
    return fingerprints.map((fingerprint) => byFingerprint.get(fingerprint));
  }

  async storeEmbeddings(model: string, entries: Array<{ text: string; vector: number[] }>): Promise<void> {
    if (!entries.length) return;
    const params: unknown[] = [model];
    const tuples = entries.map((entry) => {
      // push 返回值即新元素长度 = 该参数 1-based 占位号。
      const fingerprintIndex = params.push(embeddingFingerprint(model, entry.text));
      const vectorIndex = params.push(JSON.stringify(entry.vector));
      return `($1, $${fingerprintIndex}, $${vectorIndex}::jsonb)`;
    });
    await this.pool.query(`INSERT INTO embedding_cache(model,prompt_fingerprint,vector) VALUES ${tuples.join(",")} ON CONFLICT(prompt_fingerprint) DO NOTHING`, params);
  }

  // ---- 外部模型任务与租约：实现住在 repository/model-task-slice.ts，本层只委托 ----
  async recordPromptExecution(input: ModelPromptExecution & { contextManifestId?: string }, objects: ObjectStoreAdapter): Promise<void> {
    if (!input.workflowRunId || !input.taskId) return;
    // E5 采样判定落在此留痕本体（最低共享层）：网关回调、外部任务 submit 直连等
    // 全部消费面自动获得同源采样，不存在"某进程绕过 hook"的接线漂移面。
    let contextManifestId = input.contextManifestId;
    if (!contextManifestId && input.contextManifest) {
      const ratio = samplingRatioFromEnv();
      if (contextManifestSamplingHit(input.contextManifest, input.promptFingerprint, ratio)) {
        try {
          await this.putPromptContextManifest(input.contextManifest);
          contextManifestId = input.contextManifest.id;
        } catch (error) {
          console.warn(`[context-manifest-sampling] 物化失败（不阻塞留痕）：${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
    const promptObject = await objects.putText(JSON.stringify({ system: input.system, prompt: input.prompt }));
    const responseObject = input.response === undefined ? undefined : await objects.putText(input.response);
    // 保留天数的唯一来源见 promptExecutionRetentionDays：写入侧逐行算进 expires_at，
    // 报表侧的窗口上限也引它；删除侧刻意不另立常数（行的寿命就是 expires_at 那一列）。
    const retentionDays = promptExecutionRetentionDays();
    const id = `prompt:${randomUUID()}`;
    await this.pool.query(
      `INSERT INTO prompt_executions(id,workflow_run_id,task_id,purpose,candidate_index,status,prompt_fingerprint,response_fingerprint,prompt_object_key,response_object_key,context_manifest,context_manifest_id,error_category,expires_at,project_id)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,now()+($14::text || ' days')::interval,(SELECT r.project_id FROM workflow_runs r WHERE r.id=$2 OR r.temporal_workflow_id=$2 LIMIT 1))`,
      [id, input.workflowRunId, input.taskId, input.purpose, input.candidateIndex, input.status, input.promptFingerprint, responseObject?.hash ?? null, promptObject.key, responseObject?.key ?? null, input.contextManifest ?? null, contextManifestId ?? null, input.errorCategory ?? null, retentionDays],
    );
  }

  /**
   * OR-D3（product-audit-20260910 E5）：把 PromptContextManifest（prompt-package 级
   * 上下文预算/分段收据）物化进 context_manifests。id 为 workflow+fingerprint 确定值，
   * 重放天然去重（DO NOTHING）；列映射无损——token 收据进 payload JSONB，
   * token_budget=usableInputTokens（观测面：真正可用的 section 容量）。
   */
  async putPromptContextManifest(manifest: PromptContextManifest): Promise<void> {
    await this.pool.query(
      `INSERT INTO context_manifests(id,project_id,retrieval_run_id,source_revision_ids,token_budget,truncation_reason,fingerprint,payload)
       VALUES($1,$2,NULL,'{}',$3,NULL,$4,$5) ON CONFLICT(id) DO NOTHING`,
      [manifest.id, manifest.projectId, manifest.usableInputTokens, manifest.fingerprint, manifest],
    );
  }

  async listPromptExecutions(workflowId: string) {
    const result = await this.pool.query<{
      id: string; workflow_run_id: string; task_id: string; purpose: string; candidate_index: number; status: string;
      prompt_fingerprint: string; response_fingerprint: string | null; prompt_object_key: string | null; response_object_key: string | null;
      context_manifest: Record<string, unknown> | null; error_category: string | null; expires_at: Date | string; created_at: Date | string;
    }>(`SELECT * FROM prompt_executions WHERE workflow_run_id=$1 ORDER BY created_at,id`, [workflowId]);
    return result.rows.map((row) => ({
      id: row.id,
      workflowId: row.workflow_run_id,
      taskId: row.task_id,
      purpose: row.purpose,
      candidateIndex: row.candidate_index,
      status: row.status,
      promptFingerprint: row.prompt_fingerprint,
      responseFingerprint: row.response_fingerprint ?? undefined,
      contextManifest: row.context_manifest ?? undefined,
      errorCategory: row.error_category ?? undefined,
      expiresAt: iso(row.expires_at),
      createdAt: iso(row.created_at),
      snapshotAvailable: Boolean(row.prompt_object_key) && new Date(row.expires_at).getTime() > Date.now(),
    }));
  }

  async listModelInvocations(workflowId: string, limit = 200) {
    const boundedLimit = Math.min(Math.max(Math.floor(limit), 1), 200);
    const result = await this.pool.query(`
      SELECT invocation.id,
             invocation.workflow_run_id,
             invocation.task_id,
             invocation.purpose,
             invocation.candidate_index,
             invocation.executor,
             invocation.profile_id,
             COALESCE(invocation.provider_label, provider.label, invocation.profile_id, invocation.executor) AS provider,
             invocation.protocol,
             invocation.model,
             invocation.status,
             invocation.config_revision,
             current_config.config_revision AS current_config_revision,
             invocation.latency_ms,
             invocation.error_category,
             invocation.error_message,
             invocation.created_at
      FROM model_invocations invocation
      LEFT JOIN provider_configs provider ON provider.id=invocation.profile_id
      LEFT JOIN LATERAL (
        SELECT config_revision
        FROM model_routes
        WHERE config_revision IS NOT NULL
        ORDER BY updated_at DESC
        LIMIT 1
      ) current_config ON TRUE
      WHERE invocation.workflow_run_id=$1
      ORDER BY invocation.created_at ASC, invocation.id ASC
      LIMIT $2
    `, [workflowId, boundedLimit]);
    return result.rows.map((row) => ({
      id: Number(row.id),
      workflowRunId: row.workflow_run_id,
      taskId: row.task_id,
      purpose: row.purpose,
      candidateIndex: Number(row.candidate_index),
      executor: row.executor,
      profileId: row.profile_id ?? undefined,
      provider: row.provider ?? "未知提供方",
      protocol: row.protocol ?? undefined,
      model: row.model,
      status: row.status,
      configRevision: row.config_revision,
      isCurrentConfig: row.current_config_revision ? row.config_revision === row.current_config_revision : undefined,
      latencyMs: row.latency_ms === null ? undefined : Number(row.latency_ms),
      errorCategory: row.error_category ?? undefined,
      errorMessage: row.error_message ?? undefined,
      createdAt: new Date(row.created_at).toISOString(),
    }));
  }

  async getPromptExecutionSnapshot(id: string, objects: ObjectStoreAdapter) {
    const result = await this.pool.query<{ prompt_object_key: string | null; response_object_key: string | null }>("SELECT prompt_object_key,response_object_key FROM prompt_executions WHERE id=$1 AND expires_at>now()", [id]);
    const row = result.rows[0];
    if (!row?.prompt_object_key) return undefined;
    return {
      prompt: await objects.getText(row.prompt_object_key),
      response: row.response_object_key ? await objects.getText(row.response_object_key) : undefined,
    };
  }

  async listModelInvocationErrors(projectId?: string, limit = 50) {
    const boundedLimit = Math.min(Math.max(Math.floor(limit), 1), 50);
    const result = await this.pool.query(`
      SELECT invocation.id,
             invocation.workflow_run_id,
             invocation.task_id,
             invocation.purpose,
             invocation.candidate_index,
             invocation.executor,
             invocation.profile_id,
             invocation.config_revision,
             current_config.config_revision AS current_config_revision,
             COALESCE(invocation.provider_label, provider.label, invocation.profile_id, invocation.executor) AS provider,
             invocation.protocol,
             invocation.model,
             invocation.error_category,
             invocation.error_message,
             invocation.created_at,
             workflow.project_id,
             workflow.workflow_type,
             COALESCE(workflow.payload->>'documentId', workflow.payload #>> '{intent,target,id}') AS document_id
      FROM model_invocations invocation
      LEFT JOIN provider_configs provider ON provider.id=invocation.profile_id
      LEFT JOIN workflow_runs workflow ON workflow.temporal_workflow_id=invocation.workflow_run_id
      LEFT JOIN LATERAL (
        SELECT config_revision
        FROM model_routes
        WHERE config_revision IS NOT NULL
        ORDER BY updated_at DESC
        LIMIT 1
      ) current_config ON TRUE
      WHERE invocation.status='failed'
        AND ($1::text IS NULL OR workflow.project_id=$1)
      ORDER BY invocation.created_at DESC, invocation.id DESC
      LIMIT $2
    `, [projectId ?? null, boundedLimit]);
    return result.rows.map((row) => ({
      id: Number(row.id),
      workflowRunId: row.workflow_run_id ?? undefined,
      taskId: row.task_id ?? undefined,
      purpose: row.purpose,
      candidateIndex: Number(row.candidate_index),
      executor: row.executor,
      profileId: row.profile_id ?? undefined,
      configRevision: row.config_revision,
      isCurrentConfig: row.current_config_revision ? row.config_revision === row.current_config_revision : undefined,
      provider: row.provider ?? "未知提供方",
      protocol: row.protocol ?? undefined,
      model: row.model,
      errorCategory: row.error_category ?? undefined,
      errorMessage: row.error_message ?? undefined,
      createdAt: new Date(row.created_at).toISOString(),
      projectId: row.project_id ?? undefined,
      workflowType: row.workflow_type ?? undefined,
      documentId: row.document_id ?? undefined,
    }));
  }

  /**
   * 列出项目下所有 foundation artifacts(全书规划产出)。
   *
   * 设计依据:AGENTS.md「root-cause analysis」——v2 重构后 foundation artifacts 未被章节生成
   * 消费,导致章节生成不基于全书规划。此方法是数据访问层入口,供 novelIntentWorkflow 加载
   * 全书规划产出并注入到章节生成的 blueprint/prompt。
   *
   * 性能:单项目 foundation artifacts 通常 ≤ 11 条(对应 bootstrap_run 的 taskChain),
   * 不需要分页。ORDER BY created_at ASC 保证依赖链顺序(后生成的覆盖先生成的)。
   */
}
