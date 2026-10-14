# Triage Labels

各 skill 以五个 canonical triage 角色表述。本文件把这些角色映射到本仓库 issue tracker 实际使用的 label 字符串。

| mattpocock/skills 中的 label | 本仓库 tracker 中的 label | 含义 |
| -------------------------- | -------------------- | ---------------------------------------- |
| `needs-triage`             | `needs-triage`       | 维护者需要评估此 issue |
| `needs-info`               | `needs-info`         | 等待报告者补充信息 |
| `ready-for-agent`          | `ready-for-agent`    | 已完整指定，可交给 AFK agent |
| `ready-for-human`          | `ready-for-human`    | 需要人工实施 |
| `wontfix`                  | `wontfix`            | 不予处理 |

当某个 skill 提到某个角色（例如 “apply the AFK-ready triage label”）时，使用上表对应的 label 字符串。

本仓库使用 **Local markdown** tracker，因此这些字符串写在各 issue 文件顶部附近的 `Status:` 行，而不是平台侧 label。GitHub / GitLab 的 label 创建步骤在本仓库不适用。

修改“本仓库 tracker 中的 label”一列即可匹配你实际使用的词汇。
