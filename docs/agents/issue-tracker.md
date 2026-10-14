# Issue tracker：本地 Markdown

本仓库的 issue 与 spec 以 markdown 文件存放于 `.scratch/`。

## 约定

- 一个 feature 一个目录：`.scratch/<feature-slug>/`
- spec 为 `.scratch/<feature-slug>/spec.md`
- 实施 issue 一票一文件：`.scratch/<feature-slug>/issues/<NN>-<slug>.md`，从 `01` 起编号，禁止用单个合并的 tickets 文件
- triage 状态记录为每个 issue 文件顶部附近的 `Status:` 行（角色字符串见 `triage-labels.md`）
- 评论与会话历史追加到文件底部的 `## Comments` 标题下

## 当 skill 说 “publish to the issue tracker”

在 `.scratch/<feature-slug>/` 下新建文件（目录不存在则创建）。

## 当 skill 说 “fetch the relevant ticket”

读取所指路径的文件。通常由用户直接给出路径或 issue 编号。

## Wayfinding 操作

供 `/wayfinder` 使用。**map** 是一个文件，每个 ticket 一个**子**文件。

- **Map**：`.scratch/<effort>/map.md`（Notes / Decisions-so-far / Fog 正文）。
- **子票**：`.scratch/<effort>/issues/NN-<slug>.md`，从 `01` 起编号，正文写问题。`Type:` 行记录票型（`research`/`prototype`/`grilling`/`task`）；`Status:` 行记录 `claimed`/`resolved`。
- **阻塞**：顶部附近一行 `Blocked by: NN, NN`。当它列出的每个文件都是 `resolved` 时，该票解除阻塞。
- **Frontier**：扫描 `.scratch/<effort>/issues/`，取仍开放、无阻塞、未被认领的文件；编号最小者优先。
- **认领**：动工前先置 `Status: claimed` 并保存。
- **解决**：在 `## Answer` 标题下追加答案，置 `Status: resolved`，然后把上下文指针（要点 + 链接）追加到 `map.md` 的 Decisions-so-far。
