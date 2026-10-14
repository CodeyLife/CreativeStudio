# Domain Docs

工程类 skill 在探索代码库时应如何消费本仓库的领域文档。

## 探索之前先读这些

- 仓库根目录的 **`GLOSSARY.md`**，或
- 若存在仓库根目录的 **`GLOSSARY-MAP.md`**：它指向每个上下文各一份 `GLOSSARY.md`。读取与当前主题相关的每一份。
- **`docs/adr/`**：读取与你即将动手的区域相关的 ADR。多上下文仓库中，还要检查 `src/<context>/docs/adr/` 里的上下文级决策。

如果这些文件不存在，**静默继续**。不要指出它们缺失，也不要主动建议创建。`/domain-modeling` 技能（经 `/grill-with-docs` 与 `/improve-codebase-architecture` 抵达）会在术语或决策真正被敲定时惰性创建它们。

## 文件结构

单上下文仓库（大多数仓库）：

```
/
├── GLOSSARY.md
├── docs/adr/
│   ├── 0001-event-sourced-orders.md
│   └── 0002-postgres-for-write-model.md
└── src/
```

多上下文仓库（根目录存在 `GLOSSARY-MAP.md`）：

```
/
├── GLOSSARY-MAP.md
├── docs/adr/                          ← 系统级决策
└── src/
    ├── ordering/
    │   ├── GLOSSARY.md
    │   └── docs/adr/                  ← 上下文级决策
    └── billing/
        ├── GLOSSARY.md
        └── docs/adr/
```

本仓库当前为**单上下文**：根目录一份 `GLOSSARY.md` 加 `docs/adr/`。

## 使用 glossary 的词汇

当你的产出命名某个领域概念时（issue 标题、重构提案、假设、测试名），使用 `GLOSSARY.md` 中定义的术语。不要漂移到 glossary 明确避免的同义词。

如果你需要的概念还不在 glossary 中，这是一个信号：要么你在发明项目不使用的语言（重新考虑），要么确实存在缺口（记下来交给 `/domain-modeling`）。

## 标记 ADR 冲突

如果你的产出与既有 ADR 矛盾，明确提出来，而不是悄悄覆盖：

> _Contradicts ADR-0007 (event-sourced orders), but worth reopening because…_
