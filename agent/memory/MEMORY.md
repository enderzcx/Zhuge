# Zhuge Memory Index

Operational files
- [owner_directives.md](owner_directives.md) - hard and soft constraints from the owner
- [context.md](context.md) - short-lived working context, safe to overwrite
- [market_context.md](market_context.md) - optional market snapshot
- [trading_lessons.md](trading_lessons.md) - optional operational lessons

Recallable notes
- Store durable notes under [notes/](notes/)
- Each note should use frontmatter: `name`, `description`, `type`
- Valid types: `user`, `feedback`, `project`, `reference`
- Keep each index line short; put the detail in the note file

Other memory surfaces
- Trading lessons live in SQLite `lessons`
- Compound cognition lives in SQLite `compound_rules` and `compound_strategies`
- Knowledge base lives in LanceDB `data/knowledge/`
