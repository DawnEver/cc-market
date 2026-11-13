# Options Menu — What would you like to do?

Once the core pipeline is done, the follow-on capabilities are a menu the user chooses from freely. Optional, non-linear, composable.

## AI inference mechanism (every AI step must follow it)

**The AI call layers are decoupled: fabric first, litellm as fallback, the agent decides as needed.** The layers are independent of one another:

- **fabric** -- preferred. Claude Code's tool names are `fabric__call` / `fabric__fan_out`; Codex's equivalents are `mcp__fabric__call` / `mcp__fabric__fan_out`. Use the names the current host actually exposes; never treat one host's prefix as part of the protocol. provider = **deepseek**, default model **deepseek-v4-flash**.
- **litellm** (`chat()` in `ai/client.py`) -- the fallback for fabric; kept, not deleted.
- **CLI read/synthesize** -- runs through litellm; kept, usable as a fallback.

**Before every AI call, ask the user to confirm which backend + which model** (e.g. "fabric/deepseek-v4-flash for this paper, or litellm?"). List the task + a recommendation and wait for the user to confirm before starting. Never silently use the default.

The orchestrator writes call results straight to disk (`reading/*.md`, `notes/*.md`, etc.).

**Output language**: before every fabric call read `workspace.toml` → `[output] language` (default `en`). When it is not `en`, append to the end of the prompt:
"Write all prose in <language>. Keep JSON keys, enum values, template headings, paper titles, author names, venues, DOIs and citation identifiers in their original form." The rule in full: `SKILL.md` § Output language.

## Paper citation convention (once established, always followed)

**Reports/cards always use ShortRef (author + year); never the hash.**

- The single citation source = each workspace's `reading/papers_registry.md` (template: `<plugin-root>/configs/templates/_papers_registry_template.md`).
- In-text citation: `[Author et al. YYYY]` or `Author (YYYY)`.
- Card filename = `<author-lastname>-<year>_card.md` (with several authors take the first; same author and year get a suffix).
- `candidate_id` (hash) is only for CLI operations and never enters a narrative report.
- The card template is `<plugin-root>/configs/templates/_card_template.md` (skill level, shared across topics).

## Available Options

### Deep-Read Papers

Deep-read a paper with fabric (deepseek) → produce a paper card:
1. Copy `<plugin-root>/configs/templates/_card_template.md` to `reading/<lastname>-<year>_card.md`
2. **Ask the user to confirm the model first** (default deepseek-v4-flash)
3. Use `fabric__call` (provider=deepseek) to read the decomposed `ingest/<id>/1-paper-text/` markdown and produce a structured card
4. Append the matching row to `reading/papers_registry.md`

(The `uv run --project "<plugin-root>" lit-review read` command depends on litellm; it is superseded by the fabric mechanism and no longer used.)

### Cross-Paper Synthesis

Synthesize every paper card → `notes/synthesis.md`. Also with fabric (deepseek); confirm the model first. Always cite by ShortRef.

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

**1. Confirm the scope before importing.** Import exactly the papers the user says to import. Show the plan with a dry run first, check the scope, then execute:

```
uv run --project "<plugin-root>" lit-review zotero-import --topic <slug> --dry-run                                          # show what would import
uv run --project "<plugin-root>" lit-review zotero-import --topic <slug> --candidate-id <id1> --candidate-id <id2>          # per-paper (recommended for "just these")
uv run --project "<plugin-root>" lit-review zotero-import --topic <slug>                                                    # full workspace, only on explicit request
```

Dedup: DOI → title-key (three-pass); DOI-bearing groups CrossRef-enriched at creation.
Interactive single paper: `zotero_add_from_file` (MCP), collection + workspace tag explicit.

**2. After import**: `zotero-maintain` (registry-scoped enrich + **mirror**) + re-embed:

```
uv run --project "<plugin-root>" lit-review zotero-import --topic <slug> --candidate-id <id1> ...   # (or full)
uv run --project "<plugin-root>" lit-review zotero-maintain --topic <slug>                          # enrich + mirror; --all for whole collection
zotero_update_search_database (MCP)                                # re-embed for zotero_semantic_search
```

**3. PDF unavailable (desktop "File Not Found" / the attachment will not open)**:
- Symptom: the item has an `imported_file` attachment record, but the local `~/Zotero/storage/<key>/` is missing the file.
- Root cause: a batch import uploaded the file but never pulled it back locally.
- Fix: `uv run --project "<plugin-root>" lit-review zotero-maintain --topic <slug>` -- its **mirror** downloads into storage (md5-checked).
  Note: the directory key = the attachment's key (not the parent item key). **Do not copy PDFs into storage by hand**.

### Custom

Anything else — re-search with modified queries, add papers manually, compare specific papers, generate a summary report. Just ask.

## How it works

1. **Present the menu** after step 04 completes (or whenever the user asks).
2. **User picks** one or more options. Execute and return to menu.
3. **No forced sequence**. User can deep-read 2 papers, skip synthesis, export BibTeX, done.
4. **AI steps go through fabric(deepseek), model confirmed per call; non-AI steps use CLI.**
