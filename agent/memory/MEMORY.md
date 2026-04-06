# Agent Memory Index

- [context.md](context.md) — 当前状态 (agent 自动更新)
- [owner_directives.md](owner_directives.md) — 老板指令 (用户通过 TG 设定)
- 交易教训 → SQLite `lessons` 表 (reviewer 自动写入，用 get_active_lessons 工具查)
- 交易认知 → SQLite `compound_rules` 表 (compound 自动写入，注入 prompt)
- 知识库 → LanceDB `data/knowledge/` (RAG 向量检索，用 search_knowledge 工具查)
