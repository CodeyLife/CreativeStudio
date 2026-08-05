# Novel V2 数据恢复与质量验证

## 固定运行数据

`docker-compose.v2.yml` 固定 Compose 项目名为 `creative-studio`，并使用四个显式 external volume：

| Compose 卷 | 固定 Docker 卷 | 内容 |
| --- | --- | --- |
| `ymcp-postgres` | `creative_studio_novel_postgres` | Novel V2、Temporal、Temporal visibility 数据库 |
| `ymcp-minio` | `creative_studio_novel_minio` | 正文、artifact、prompt/response 对象 |
| `ymcp-qdrant` | `creative_studio_novel_qdrant` | 章节与事实检索索引 |
| `ymcp-tei-cache` | `creative_studio_novel_tei_cache` | 本地 embedding 模型缓存 |

external volume 不存在时 Compose 必须失败，不能因仓库目录或项目名变化静默创建空卷。

恢复命令：

```powershell
pnpm novel:v2:restore:dry-run
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/restore-novel-v2-volumes.ps1
pnpm novel:v2:verify-data
```

恢复脚本要求源卷和目标卷均无运行容器挂载；目标卷存在但非空时拒绝覆盖。旧卷不会被删除。数据验收会检查 `ymcp`、`temporal`、`temporal_visibility`、项目修订、final 章节数、MinIO 正文 SHA-256、Qdrant collection 和运行服务 readiness。

2026-08-04 的恢复结果：`novel-create-wanfa-20260801` / 《万法归渊》恢复到 revision 22，六章均为 final，六个正文对象哈希一致。

## 正式审校边界

修改正式章节内容的入口只有 `chapterReviewWorkflow`，并复用 `review → revise → manuscriptApproval → extractFacts → approveFacts → commit → enrichCharacters`。CreativeRun 的 `review.request` 只生成只读预览，不写入 `creative_reviews`、不满足 review gate、也不发送推进信号；需要显式 `review.submit` 才能影响 CreativeRun。

章节 review 记录保存模型、route snapshot、prompt fingerprint、SkillBundle id/fingerprint 和 context manifest id。最终采用版本由 `manuscript_revisions.artifact_id` 回指，质量判断可以从正文追到 prompt、Skill、review 和 commit。

## 质量基线

执行以下命令导出只读质量基线：

```powershell
pnpm novel:v2:quality:export -- --project-id novel-create-wanfa-20260801
```

产物写入忽略目录 `.novel-bench/baselines/`，包含六章正文、Foundation/blueprint/memory/Skill payload、artifact、review、workflow、model invocation，以及保留期内可读取的 prompt/response。默认样本为第 1 章高压力行动场景和第 6 章低行动量观察/判断场景。

基线只是问题证据，不是提示词修改规范。单个标题、句子、角色名、题材词或外语词不得变成黑名单。

## A/B 门禁

baseline 与 candidate 各自必须提供两章、每章三次正式工作流产物：

```text
variant/
  chapter-001/run-1.txt
  chapter-001/run-1.json
  ... run-2 / run-3
  chapter-006/run-1.txt
  ... run-2 / run-3
```

每个 JSON 必须记录 completed workflowId、artifactId、promptFingerprint、skillBundleFingerprint 和 model。使用以下命令随机隐藏版本身份：

```powershell
pnpm novel:v2:quality:compare -- --baseline <baseline-variant> --candidate <candidate-variant>
```

公开 `review.md`/`manifest.json` 与私有 `mapping.private.json` 分离。盲评覆盖 D1-D5，并允许 D1/D3/D4/D5 不适用；同时检查场景承载、因果可信度、内心活动、语域、节奏和连续性。候选必须在两个章节功能上都没有 blocker/major 回归，不能靠整体均分掩盖局部退化，也不能把安静章节改造成事件清单。

在当前流水线尚未复现同一根因、或盲评未通过前，只合并数据恢复与流程可靠性改动，不增加文学提示词约束。CraftRule promote 后必须用同一组跨场景样本重跑。
