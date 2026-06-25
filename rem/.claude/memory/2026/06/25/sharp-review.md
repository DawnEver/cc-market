---
name: sharp-review-2026-06-25
description: Sharp review findings — 26 total
metadata:
  type: project
---

## Review 2026-06-25 (session) — docs review (文档锐评)

### Reviewer Status
- Reviewer A (Codex): skipped
- Reviewer B (DeepSeek): OK
- Reviewer C (Opus): OK

### Confirmed findings

---

### [SR-20260625-001] [HIGH] README.md — Line 72 claims setup-vscode.js writes `claudeCode.claudeProcessWrapper`, but the code writes `claudeCode.environmentVariables` and only removes `claudeProcessWrapper` as legacy cleanup.

- **Category:** Bug
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** s/claudeCode.claudeProcessWrapper/claudeCode.environmentVariables/, and note that the legacy `claudeProcessWrapper` is cleaned up.

setup-vscode.js writes `claudeCode.environmentVariables` (the actual VS Code extension key) and sets `claudeCode.disableLoginPrompt`. It never writes `claudeCode.claudeProcessWrapper` — it only deletes it as a one-time cleanup of old-format configs.

---

### [SR-20260625-002] [HIGH] .claude/rules/rem/providers.md — Entire section documents `scripts/runtime/api-proxy.js` (DeepSeek proxy on port 3082), but the file does not exist — DeepSeek now uses Foundry mode directly via `cc.js`.

- **Category:** Bug
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Remove the 'DeepSeek Proxy' section and the invariant entries about `SAFE_REQ_HEADERS`, `stripCacheControl()`, and KV-cache metrics. Replace with a note that DeepSeek connects via Foundry mode (`CLAUDE_CODE_USE_FOUNDRY=1`).

`cc.js` no longer starts a proxy; it passes Foundry env vars directly. `claude_env_settings.template.json` shows `ANTHROPIC_FOUNDRY_BASE_URL` and `ANTHROPIC_FOUNDRY_API_KEY`. The documented proxy invariants (cache-control headers, KV-cache metrics) refer to code that was deleted.

---

### [SR-20260625-003] [MEDIUM] README.md — Line 130 claims `.claude/rules/MEMORY.md` is 'referenced from GLOBAL-AGENTS.md', but GLOBAL-AGENTS.md contains only global preferences and no such reference.

- **Category:** Bug
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Replace with: 'Loaded automatically by Claude Code as a `.claude/rules/` file each session.'

The index loads because Claude Code auto-injects all `.claude/rules/` files into every session context — not because GLOBAL-AGENTS.md references it.

---

### [SR-20260625-004] [MEDIUM] claude_settings.template.json — Line 34 grants `Skill(update-config)` permission, but no `update-config` skill exists anywhere in the repo or in cc-market.

- **Category:** Bug
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Remove `"Skill(update-config)"` from the permissions allow list.

Only `skills/migrate/` and `skills/git-tidy/` exist in the repo's `skills/` directory. No `update-config` SKILL.md exists.

---

### [SR-20260625-005] [MEDIUM] AGENTS.md — Line 37 references `.claude/workflows/` directory and `cc-market/sharp-review/workflows/` — neither directory exists.

- **Category:** Bug
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Either create the directories or remove the workflow entry from the Structure section until content exists.

Both `.claude/workflows/` and `cc-market/sharp-review/workflows/` return ENOENT. The sharp-review workflow lives at `cc-market/sharp-review/scripts/sharp-review-workflow.js`, not under a `workflows/` directory.

---

### [SR-20260625-006] [LOW] README.md — Line 87 hook table header uses `StatusLine` (PascalCase), but the actual config key in `claude_settings.template.json` is `statusLine` (camelCase).

- **Category:** Bug
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** s/StatusLine/statusLine/ in the table header.

---

### [SR-20260625-007] [LOW] README.md — Line 120 test command references `~/.claude/models.md` which is never created or linked by setup.

- **Category:** Bug
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Replace with a file that actually exists (e.g. `~/.claude/CLAUDE.md`) or note that any file path works for testing permissions.

`models.md` is not in CLAUDE_LINKS and setup never creates it. The command would trigger a permission prompt for a non-existent file, which may still test the permission system but is misleading.

---

### [SR-20260625-008] [LOW] AGENTS.md — Line 22 says `scripts/runtime/` contains `aliases.sh` and `aliases.ps1` — these exist but `todo-launcher.mjs` and `traceme-launcher.mjs` are also in that directory and are unmentioned in the structure list.

- **Category:** Feature
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Add `todo-launcher.mjs` and `traceme-launcher.mjs` to the `scripts/runtime/` description for completeness.

The setup.js installs both launchers as CLI aliases, so documenting them helps users understand what's in that directory.

---

### [SR-20260625-009] [HIGH] skills/rem/reference/memory-conventions.md — YAML frontmatter example shows `created`, `accessed`, `tier`, `access_count` as frontmatter fields — they actually live in `_meta.json` per-date

- **Category:** Bug
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Remove `created`, `accessed`, `tier`, `access_count` from the YAML example; only `name`, `description`, and `metadata.type` belong in frontmatter

Actual memory files (e.g. compact-renamed-to-crystallize.md) only have `name`, `description`, `metadata.type` in frontmatter. Volatile fields are stored in `_meta.json` as `{accessed, count, tier, dropped}`. The invariants.md correctly states: "Volatile metadata (accessed, count, tier, dropped) lives in per-date _meta.json — never in frontmatter." The YAML example contradicts both the code and invariants.md.

---

### [SR-20260625-010] [HIGH] skills/rem/reference/memory-conventions.md — Says root MEMORY.md Scoped section is "hand-maintained" and "add a line here" — but `rebuildIndex()` in lib.mjs auto-generates it from `findChildScopes()`

- **Category:** Bug
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Replace "hand-maintained" with "auto-generated by rebuildIndex() from child scopes discovered on disk" and remove the instruction to manually add lines

lib.mjs rebuildIndex() iterates findChildScopes() and emits the Scoped section automatically. prune-memory.js, stamp-memory.js, touch-memory.js, scope-split.js all call rebuildIndex() which overwrites any hand-edits. The INDEX_HEADER also says "GENERATED — do not hand-edit."

---

### [SR-20260625-011] [HIGH] skills/rem/reference/memory-conventions.md — Uses `access_count` throughout but the actual `_meta.json` field name is `count`

- **Category:** Bug
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Replace all `access_count` references with `count` to match lib.mjs `bumpAccessed()` and `_meta.json` format

lib.mjs bumpAccessed(): `const count = cur.accessed !== date ? cur.count + 1 : cur.count;` — field is `count`, not `access_count`. rem-prep.js promotion check: `if (meta.count >= 3)`. SKILL.md (rem) also uses `access_count` which is wrong.

---

### [SR-20260625-012] [MEDIUM] AGENTS.md — scripts/ listing uses abbreviated names (`stamp`, `prune`, `touch`) and is missing `scope-validate.mjs`

- **Category:** Bug
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Use actual filenames: `stamp-memory.js`, `prune-memory.js`, `touch-memory.js`; add `scope-validate.mjs` to the listing

Line 38 shows `stamp, prune, touch` instead of `stamp-memory.js, prune-memory.js, touch-memory.js`. The file `scope-validate.mjs` exists on disk in scripts/ but is not listed at all.

---

### [SR-20260625-013] [MEDIUM] AGENTS.md — Test file list missing 5 files that exist on disk: inject-rules.test.mjs, memory-state.test.mjs, migrations.test.mjs, scope-validate.test.mjs, task-engine-cli.test.mjs

- **Category:** Bug
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Add the 5 missing test files to the Test files list on line 65

AGENTS.md lists 7 test files; 12 exist on disk in `cc-market/rem/tests/`.

---

### [SR-20260625-014] [MEDIUM] skills/rem/reference/scripts.md — stamp-memory.js description says it adds `created`/`accessed`/`tier` to all files — actual code only warns on missing `name:` and rebuilds the index

- **Category:** Bug
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Change description to: "Create dirs, warn on missing `name:` frontmatter, rebuild MEMORY.md index"

stamp-memory.js creates .claude/memory/ and .claude/rules/ dirs, iterates collectMemoryFiles() to warn on missing `name:` frontmatter, then calls rebuildIndex() for all scopes. It never writes `created`/`accessed`/`tier` fields — those live in `_meta.json`.

---

### [SR-20260625-015] [MEDIUM] skills/rem/reference/scripts.md — task-engine.js subcommands listed as "report, add, remove, help" — missing `show`, `mark`, `check`

- **Category:** Bug
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** List all subcommands: `report, add, remove, show, mark, check, help`

task-engine.js main() supports: add/--add/-a, remove/rm/--remove/--rm/-r, mark/--mark/-m, show/--show, report/check/--report, help/--help/-h. The help output correctly lists all, but scripts.md omits show, mark, and check.

---

### [SR-20260625-016] [MEDIUM] skills/todo/SKILL.md — `/todo add` command documentation missing the `--scope` flag that task-engine.js supports

- **Category:** Bug
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Add `--scope <path>` to the add command options: "target scope (default: auto-detect from cwd)"

task-engine.js handleAdd() parses `--scope` flag at line 30-35 to target a specific memory scope. The task-engine.js help output documents it, but SKILL.md omits it.

---

### [SR-20260625-017] [MEDIUM] AGENTS.md — Pre-commit hook description says "runs all rem tests + takeover + sharp-review tests" — cc-market pre-commit is scoped to changed plugins only

- **Category:** Bug
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Change to: "Pre-commit hook runs rem tests when rem files are staged"

cc-market AGENTS.md states: "The pre-commit hook runs only the tests for plugins whose files are staged." rem AGENTS.md line 63 overstates and implies all three plugin test suites always run.

---

### [SR-20260625-018] [MEDIUM] skills/rem/reference/memory-conventions.md — Index section says "max 20 entries" — ambiguous; only short-term entries are capped at 20, long-term entries are protected

- **Category:** Bug
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Clarify: "Max 20 short-term entries (long-term entries are protected from count-based eviction)"

prune-memory.js: `const over = shortTerm.length - MAX_ENTRIES;` — the cap is applied only to short-term. Long-term entries are never dropped by count, only demoted by inactivity between prune cycles.

---

### [SR-20260625-019] [MEDIUM] scripts/stamp-memory.js — Code comment header says step 2 is "Run scope-validate --fix" but the code never imports execFileSync or calls scope-validate

- **Category:** Bug
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Either remove step 2 from the comment, or add the actual scope-validate --fix call (as prune-memory.js does)

The comment at lines 1-7 lists 4 steps; step 2 says "Run scope-validate --fix to ensure intermediate file integrity" — but the code body only does steps 1, 3, and 4. No `execFileSync` import exists.

---

### [SR-20260625-020] [MEDIUM] skills/rem/SKILL.md — Line 71 `check-docs.js` reference missing `${CLAUDE_PLUGIN_ROOT}/scripts/` prefix — inconsistent with all other script references in the same file

- **Category:** Bug
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Write as `node ${CLAUDE_PLUGIN_ROOT}/scripts/check-docs.js` to match every other command in SKILL.md

Every other script invocation in SKILL.md uses the full `node ${CLAUDE_PLUGIN_ROOT}/scripts/<name>` path. Line 71 just says "Run `check-docs.js`" without the path prefix.

---

### [SR-20260625-021] [LOW] README.md — SessionStart hook config example is missing the `inject-rules.js` hook and the `--quiet` flag on prune-memory.js — both present in hooks/hooks.json

- **Category:** Bug
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Add the inject-rules.js hook entry and `--quiet` flag to match hooks.json

hooks.json SessionStart has two hooks: prune-memory.js --evict-stale --quiet (timeout 5) and inject-rules.js (timeout 5). README only shows prune-memory.js --evict-stale without --quiet, and omits inject-rules.js entirely.

---

### [SR-20260625-022] [LOW] README.md — "runs all plugin tests before every commit" — cc-market pre-commit is scoped to changed plugins only, not all plugins

- **Category:** Bug
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Change to: "runs the tests for any plugin whose files are staged"

cc-market AGENTS.md explicitly says: "runs only the tests for plugins whose files are staged." README and rem's AGENTS.md both overstate.

---

### [SR-20260625-023] [LOW] skills/rem/reference/memory-conventions.md — Nested YAML `metadata:
  type:` in frontmatter example cannot be parsed by `parseFrontmatter()` flat key-value regex

- **Category:** Bug
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Either document the flat format (e.g. `metadata.type: project`) or update parseFrontmatter() to handle nested YAML

parseFrontmatter() in lib.mjs uses `/^(\w+):\s*(.*)/` per-line regex. The line `  type: project` starts with spaces, so `^(\w+)` fails to match. `metadata.type` is effectively unreadable by the parser.

---

### [SR-20260625-024] [LOW] scripts/lib.mjs — INDEX_HEADER comment says `metadata.type` is "(required)" but no code ever validates it — stamp-memory.js only checks `name:`

- **Category:** Bug
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Remove "(required)" from the comment, or add validation in stamp-memory.js and/or rebuildIndex()

stamp-memory.js only warns on missing `name:`. `metadata.type` is never checked. Since parseFrontmatter() can't even read nested YAML, the field is effectively invisible to validation.

---

### [SR-20260625-025] [LOW] skills/rem/reference/state-schema.md — Omits `scopes.split` config section that scope-split.md and lib.mjs `resolveSplitConfig()` support

- **Category:** Bug
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Add `"split": { "minOwnEntries": 30, "minClusterEntries": 5, "maxBytes": 524288 }` to the `scopes` example

scope-split.md documents scopes.split overrides. lib.mjs resolveSplitConfig() reads `loadState().scopes?.split`. state-schema.md shows `scopes.ignore` but not `scopes.split`.

---

### [SR-20260625-026] [LOW] scripts/lib.mjs — INDEX_HEADER comment has typo: `_memory/YYYY/MM/DD/_meta.json` should be `.claude/memory/YYYY/MM/DD/_meta.json`

- **Category:** Bug
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Change `_memory/` to `.claude/memory/` in the INDEX_HEADER comment at line 294-295

The generated MEMORY.md files inherit this typo. The actual _meta.json files live under `.claude/memory/`, not `_memory/`.
