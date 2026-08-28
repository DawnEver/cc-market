# Papers Registry — 论文引用映射表

`generated: <date>` · **唯一引用源**。所有报告/卡片用 **ShortRef**(作者+年份)引用,禁用 hash。

> **规则**
> 1. 报告正文一律用 `[Author et al. YYYY]` 或 `Author (YYYY)`。
> 2. 文件名 = `<author-lastname>-<year>_card.md`(多名作者取首个;同作者同年加后缀区分)。
> 3. `candidate_id`(hash)只用于 CLI 操作(read/acquire/ingest),**绝不进入叙述性报告**。
> 4. card 模板见 `../templates/_card_template.md`。
> 5. 每加入一篇 include 论文,追加一行。

| ShortRef | Filename | candidate_id (仅内部) | Title | Authors | Year | Venue |
|----------|----------|----------------------|-------|---------|------|-------|
| **<AuthorLastname> et al. <year>** | `<lastname>-<year>_card.md` | S2-<hash> | <Title> | <Authors> | <year> | <venue> |
