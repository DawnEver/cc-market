# Options Menu — What would you like to do?

核心流水线完成后，后续能力作为选项菜单供用户自由选择。非强制、非线性、可组合。

## AI 推理机制（所有 AI 步骤必须遵守）

**AI 调用层解耦，fabric 优先，litellm 回退，agent 按需决策。** 各层互相独立：

- **fabric**——首选。Claude Code 的工具名是 `fabric__call` / `fabric__fan_out`；Codex 的等价工具名是 `mcp__fabric__call` / `mcp__fabric__fan_out`。使用当前 host 实际暴露的名称，不把某一 host 的前缀视为协议的一部分。provider = **deepseek**，默认模型 **deepseek-v4-flash**。
- **litellm**（`ai/client.py` 的 `chat()`）—— 作为 fabric 的回退，保留不删。
- **CLI read/synthesize** —— 走 litellm，保留，可用作回退。

**每次 AI 调用前必须先询问用户确认用哪个后端 + 哪个模型**（如"这篇用 fabric/deepseek-v4-flash,还是 litellm?"）。列出任务 + 建议,等用户确认后再发起。绝不默默用默认。

调用结果直接由 orchestrator 落盘（写 `reading/*.md`、`notes/*.md` 等）。

## 论文引用规范（建立后永久遵守）

**报告/卡片一律用 ShortRef（作者+年份），禁用 hash。**

- 唯一引用源 = 各 workspace 的 `reading/papers_registry.md`（模板见 `<plugin-root>/configs/templates/_papers_registry_template.md`）。
- 正文引用：`[Author et al. YYYY]` 或 `Author (YYYY)`。
- 卡片文件名 = `<author-lastname>-<year>_card.md`（多名作者取首个；同作者同年加后缀）。
- `candidate_id`(hash) 只用于 CLI 操作，绝不进入叙述性报告。
- card 模板见 `<plugin-root>/configs/templates/_card_template.md`（skill 层，跨 topic 共享）。

## Available Options

### Deep-Read Papers

用 fabric(deepseek) 对论文做深度阅读 → 生成 paper card：
1. 复制 `<plugin-root>/configs/templates/_card_template.md` 为 `reading/<lastname>-<year>_card.md`
2. **先询问用户确认模型**（默认 deepseek-v4-flash）
3. 用 `fabric__call`（provider=deepseek）读分解后的 `ingest/<id>/1-paper-text/` markdown，产出结构化 card
4. 追加对应行到 `reading/papers_registry.md`

（`uv run --project "<plugin-root>" lit-review read` 命令依赖 litellm，已被 fabric 机制取代，不再使用。）

### Cross-Paper Synthesis

综合所有 paper card → `notes/synthesis.md`。同样用 fabric(deepseek)，先确认模型。引用一律用 ShortRef。

### Export

```bash
uv run --project "<plugin-root>" lit-review export --topic <slug> [--format markdown|csv|bibtex|json] [--paper <id1> ...]
```
Exports paper cards in the requested format to `export/`.

### Statistics & Plots

```bash
uv run --project "<plugin-root>" lit-review stats --topic <slug> [--plots]
```
Summary statistics (candidates, screening breakdown, downloads, decomposed, deep-read). With `--plots`, generates year/venue distribution charts.

### Zotero Sync

**Capability gate:** Zotero is optional. Before offering or executing an MCP-only Zotero action, check whether the current host exposes the required Zotero tools. A project `.mcp.json` being present does not prove that Codex loaded it. If unavailable (commonly in Codex), say clearly that Zotero sync is disabled in this session, keep the local registry/export workflow usable, and offer `uv run --project "<plugin-root>" lit-review export --format bibtex|json` as the non-destructive fallback. Never fabricate a successful sync. CLI `zotero-import`/`zotero-maintain` may still be used only when their configured backend is independently available.

All papers → ONE shared Zotero collection (from `workspace.toml` → `[zotero]`, resolved by
`collection_key`, names are not unique). Workspace identity = `zotero_registry.jsonl` +
workspace tag. Never create per-topic collections.

**1. 确认范围再导入。** 用户说"导入哪几篇"就导入哪几篇。先 dry-run 展示计划,核对范围后执行:

```
uv run --project "<plugin-root>" lit-review zotero-import --topic <slug> --dry-run                                          # show what would import
uv run --project "<plugin-root>" lit-review zotero-import --topic <slug> --candidate-id <id1> --candidate-id <id2>          # per-paper (recommended for "just these")
uv run --project "<plugin-root>" lit-review zotero-import --topic <slug>                                                    # full workspace, only on explicit request
```

去重:DOI → title-key(three-pass);DOI-bearing groups CrossRef-enriched at creation。
Interactive single paper: `zotero_add_from_file` (MCP), collection + workspace tag explicit.

**2. Import 后**:`zotero-maintain`(registry-scoped enrich + **mirror**)+ re-embed:

```
uv run --project "<plugin-root>" lit-review zotero-import --topic <slug> --candidate-id <id1> ...   # (or full)
uv run --project "<plugin-root>" lit-review zotero-maintain --topic <slug>                          # enrich + mirror; --all for whole collection
zotero_update_search_database (MCP)                                # re-embed for zotero_semantic_search
```

**3. PDF unavailable(桌面 "File Not Found" / 附件打不开)**:
- 症状:item 有 `imported_file` attachment 记录,但本地 `~/Zotero/storage/<key>/` 缺文件。
- 根因:批量 import 上传后未拉回本地。
- 修复:`uv run --project "<plugin-root>" lit-review zotero-maintain --topic <slug>` 的 **mirror** 下载到 storage(md5 校验)。
  注意目录 key = attachment 的 key(非父 item key)。**不要手动复制 PDF 到 storage**。

### Custom

Anything else — re-search with modified queries, add papers manually, compare specific papers, generate a summary report. Just ask.

## How it works

1. **Present the menu** after step 04 completes (or whenever the user asks).
2. **User picks** one or more options. Execute and return to menu.
3. **No forced sequence**. User can deep-read 2 papers, skip synthesis, export BibTeX, done.
4. **AI steps go through fabric(deepseek), model confirmed per call; non-AI steps use CLI.**
