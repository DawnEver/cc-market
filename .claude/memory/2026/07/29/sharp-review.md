---
name: sharp-review-2026-07-29
description: Sharp review findings — 81 total
metadata:
  type: project
---






## Review 2026-07-29 (session) — adversarial review (对抗性审查) + diff review

### Reviewer Status
- Reviewer A (Codex): skipped
- Reviewer B (DeepSeek): OK
- Reviewer C (Opus): OK

### Confirmed findings

---

### [SR-20260729-001] [HIGH] shared/lock.mjs (all copies) — sync sleep using Atomics.wait will throw in Node.js main thread, crashing lock acquisition

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Replace Atomics.wait with a compatible blocking mechanism (e.g. execSync sleep, or a busy loop with hrtime) or document that this module requires a worker thread / Node.js with --experimental-wasm-threads.

sleepMs calls Atomics.wait on a SharedArrayBuffer. In Node.js main thread (the environment of hook scripts) this is disallowed and throws 'Atomics.wait cannot be called in the main thread'. This will cause withLock to throw, leak the lockfile, and break any hook that acquires a lock, making the entire locking infrastructure unusable on standard Node setups.

---

### [SR-20260729-002] [HIGH] rem/scripts/remember.js — frontmatter format mismatch: remember.js writes flat 'metadata.type' while prune and recall expect nested YAML, breaking feedback retention

- **Category:** Bug
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Write nested YAML (metadata:
  type: ...) in remember.js to match parseNestedFrontmatter expectations, or add a fallback to the flat key in prune-memory.js and recall.js.

remember.js constructs frontmatter with line 'metadata.type: feedback' (single string key with a dot). prune-memory.js uses parseNestedFrontmatter to read metadata.type as a nested object, which will not find the type for files created by remember.js. Consequently, feedback entries created via remember.js are exempt from the feedback retention rule and may be evicted early.

---

### [SR-20260729-003] [MEDIUM] rem/scripts/prune-memory.js — TOCTOU race: analysis phase reads state without lock, mutation under lock acts on potentially stale decisions

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Move the entire read-and-decide logic inside the prune lock, or re-validate decisions after acquiring the lock (e.g., re-check staleness and tiers) before mutating.

The script collects entries and decides demotions/drops (demoted, dropSet) while no lock is held. Concurrent processes can insert, promote, or touch entries in the window between analysis and the withLock block. Under the lock, these decisions are applied unconditionally, which can incorrectly demote or drop entries that no longer meet the conditions.

---

### [SR-20260729-004] [MEDIUM] rem/scripts/touch-memory.js — reads metadata (getMemoryMeta) outside the lock, leading to bump based on stale data

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Move getMemoryMeta inside the lock block so that bumpAccessed and promote decisions are based on the current state after lock acquisition.

touch-memory.js reads the current meta (cur.dropped, cur.tier) before acquiring the index lock. A concurrent touch/promote/drop could change these values, causing bumpAccessed to operate on an outdated picture and potentially misclassify the entry or re-apply a promote that was reversed.

---

### [SR-20260729-005] [LOW] rem/scripts/prune-memory.js — feedback exemption does not consider top-level 'type' frontmatter from older memory files

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Fall back to fm.type when metadata.type is missing, or output a migration warning.

If memory files were created with a flat 'type: feedback' key (e.g., prior conventions or hand-written), parseNestedFrontmatter will not recognise them and they will be evicted as stale non-feedback entries. This silently loses user feedback data.

---

### [SR-20260729-006] [LOW] rem/scripts/remember.js — 'isNewEntry' check outside lock exposes a small race window with concurrent remember scripts

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Load state inside withLock or compare after acquiring a per-scope lock, though the probability is low.

remember.js determines isNewEntry by a read before any locking. If two processes run concurrently, both may decide the entry is new and write meta, potentially overwriting each other's accessed timestamps.

---

### [SR-20260729-007] [LOW] shared/lock.mjs (all copies) — fallback to proceed without lock after timeout can cause concurrent writes and silent data corruption

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Document this tradeoff explicitly in the module header; consider an option to fail hard or retry longer for critical paths.

The lock is described as best-effort. If a hook times out on lock acquisition, it runs the critical section anyway. Two concurrent runs can then overwrite the same file (state, index, meta) without detection, losing updates. This is intentional but risky.

---

### [SR-20260729-008] [HIGH] rem/scripts/remember.js — remember.js writes flat `metadata.type: <type>` frontmatter, but prune/recall read the nested `metadata:\n  type:` form — feedback entries created via remember.js silently lose the 90-day eviction exemption and user/feedback recall weighting

- **Category:** Bug
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Change the generated frontmatter to nested YAML (`metadata:\n  type: ${type}`), or confirm shared/lib.mjs's structured parseFrontmatter expands dotted keys into nested objects and add a cross-tool test (remember.js output fed through prune's type detection)

remember.js emits `---\nname: X\ndescription: Y\nmetadata.type: feedback\n---` (a single dotted flat key), and remember.test.mjs enshrines that exact string. Meanwhile prune-memory.js explicitly switched to the structured parser with the comment 'metadata.type is nested YAML — needs the structured parser, not the flat one' and reads `parseNestedFrontmatter(content)?.metadata?.type`; its test fixtures all use nested `metadata:\n  type: feedback`. recall.js does `fm.metadata && typeof fm.metadata === 'object' ? fm.metadata : {}` then `md.type || fm.type` — a flat `metadata.type` key yields fm.metadata === undefined and fm.type === undefined, so the entry is classified 'project'. The repo's own canonical memory file (rem/.claude/memory/2026/07/29/rem-vs-cc-codex-memory.md) also uses the nested form. Unless the shared structured parser expands dotted keys (not verifiable from the diff, and the prune comment strongly implies flat vs nested are distinct), every memory written by remember.js is mis-typed downstream: stale 'feedback' entries written via the fast path will be evicted at 90 days, defeating the feature this PR ships.

---

### [SR-20260729-009] [MEDIUM] rem/skills/rem/reference/crystallize.md — Docs promise a `dropped: 'drifted'` tombstone reason for drift-drops, but no code path can write it — --execute always writes 'crystallized'

- **Category:** Bug
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Either add a reason parameter (e.g. `crystallize.js --execute --distilled <paths> --reason drifted`, or a `dropFromIndex(scopeRoot, p, 'drifted')` CLI such as touch-memory --drop), or correct the doc to say drift-dropped entries are tombstoned as 'crystallized'

The new crystallize.md § Drift verification step 0 states: 'When the user confirms a drift-drop, its tombstone reason in _meta.json is dropped: 'drifted' (distinct from 'crystallized')'. But crystallize.js --execute calls `dropFromIndex(scopeRoot, p, 'crystallized')` unconditionally for both granular and full modes, and no other script in the diff writes a 'drifted' reason. An agent following the skill doc literally has no command that produces the documented tombstone, so any future logic/reporting that filters on `dropped === 'drifted'` will find nothing.

---

### [SR-20260729-010] [MEDIUM] rem/scripts/prune-memory.js — Prune still saves a stale state snapshot inside the lock — concurrent appendEvent (demote/evict from rem-hook or another prune) between the top-of-script loadState and saveState is silently lost

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Re-load the state inside the .prune critical section (`state = loadState(...)` right before `state.prune.lastPruneAt = now; saveState(state)`), or route the lastPruneAt update through a load→modify→save helper like appendEvent now uses

`state` is loaded during the classification phase (before scanning all memory files and parsing frontmatter — potentially seconds), then `saveState(state)` writes the whole object back inside `withLock(join(memDir, '.prune'), ...)`. The new locks only serialize against other prune runs; rem-hook/stamp take the per-stateFile lock via appendEvent, which now does an atomic load→modify→save — but prune's saveState overwrites the entire file with its stale snapshot, clobbering any events appended in between. The lock wiring prevents torn writes, not this lost-update; the fix is to re-read state within the critical section.

---

### [SR-20260729-011] [MEDIUM] shared/lock.mjs — Release unconditionally unlinks the lockfile — after a stale-steal (critical section longer than staleMs=60s) the original holder's finally deletes the new owner's lock, opening a window for a third process to enter concurrently

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** On release, verify ownership before unlinking: read the lockfile and only unlink if the stored {pid, at} matches the token this process wrote (or compare fd via fstat); skip unlink on mismatch

`finally { closeSync(fd); unlinkSync(file); }` runs unconditionally. Lease locks without fencing have the classic failure: process A holds the lock and runs a long section (rebuildIndex over many scopes in prune, or a slow hook on a loaded machine exceeding 60s); process B sees mtime older than staleMs, steals, writes its token; A finishes and unlinks B's live lockfile; process C now acquires immediately and mutates state concurrently with B. Since the token ({pid, at}) is already written into the file, an ownership check before unlink is cheap. Also note the lock mtime is never refreshed by the holder, so any legitimate section > staleMs is stealable by design — the ownership check at least prevents the cascading third-party entry.

---

### [SR-20260729-012] [LOW] rem/scripts/recall.js — Tokenizer is ASCII-only ([^a-z0-9]+, English stopwords) — Chinese/CJK prompts tokenize to nothing and auto-recall silently never fires, though the repo's memory corpus is bilingual

- **Category:** Bug
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Keep CJK sequences as tokens (e.g. split on /[^\p{L}\p{N}]+/u or add a /[\u4e00-\u9fff]+/ extraction pass) so Chinese prompts can match Chinese memory names/descriptions

`tokenize` lowercases and splits on /[^a-z0-9]+/, dropping every CJK character; a prompt like '记住这个：不要 force-push' yields only latin tokens, and a fully Chinese prompt yields [] → main() returns silently. The bundled memory rem/.claude/memory/2026/07/29/rem-vs-cc-codex-memory.md is largely Chinese, and the feature memory explicitly targets '记住这个' phrasing for remember.js, so the recall half of the feature is dead for the same language the project documents in. No test covers a non-ASCII prompt.

---

### [SR-20260729-013] [LOW] rem/scripts/remember.js — Derived --description is interpolated into YAML frontmatter unescaped — a body first line containing ': ' or other YAML metacharacters produces invalid frontmatter that recall then skips

- **Category:** Bug
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Quote or sanitize the derived description (e.g. strip/replace ':' and '#', or JSON.stringify the scalar) before writing `description: ${desc}`

`desc` comes from the first non-empty body line (markdown/markup stripped, sliced to 80 chars) and is inlined as `description: ${desc}`. A body like 'Note: never do X' yields `description: Note: never do X`, which is malformed YAML; recall.js's collectCandidates wraps parseFrontmatter in try/catch and `continue`s on failure, so the entry is silently invisible to recall and prune's type detection. The volatile-field guard (VOLATILE_RE) doesn't cover this.

---

### [SR-20260729-014] [LOW] rem/scripts/prune-memory.js — --dry-run classification now folds demoted long-term entries into shortTerm (moved out of the !dryRun guard), changing dry-run stale/over-capacity counts versus actual non-dry-run behavior and prior releases

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** If intentional (more accurate projection), note it in the header comment/AGENTS; otherwise gate the shortTerm.push(e)/longTerm.splice behind !dryRun as before, or recompute tiers from scratch in the mutation phase

Previously demoted entries were only pushed into shortTerm when mutating; now the splice/push happens unconditionally during classification. In dry-run, entries that would be demoted are now counted as short-term for the stale filter and the MAX_ENTRIES over-cap computation, so `--dry-run` output (stale counts, 'dropping N oldest', the summary line) differs from both old behavior and from what a fresh non-dry-run invocation would classify (where demotions from *this* run haven't been applied to _meta.json yet). It's arguably a more truthful preview, but it's an undocumented behavior change in a read-only flag.

---

### [SR-20260729-015] [INFO] shared/tests/lock.test.mjs — Lock tests exist only for the top-level shared/ copy; the six other bundled copies (evolve/fabric/rem/sharp-review/traceme/watch) have no test coverage and nothing guards the copies from drifting

- **Category:** Feature
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Add a parity check (hash/diff of the 7 lock.mjs + state.mjs + stamp.mjs copies) to CI or pre-commit, mirroring whatever process keeps stamp/state in sync

The diff adds byte-identical lock.mjs to all 7 plugin shared/ dirs plus identical withLock wiring in 7 copies each of state.mjs/stamp.mjs, but only shared/tests/lock.test.mjs tests one copy. rem/scripts/lib.mjs, prune-memory.js, crystallize.js, touch-memory.js, remember.js import '../shared/lock.mjs' (the rem copy). A future edit to one copy without the others (the exact failure mode the 7-copy layout invites) would be caught by no test. The memory file also notes the commit used --no-verify to bypass 4 pre-existing fabric proxy/image test failures — those remain unaddressed by this PR.


## Review 2026-07-29 (follow-up)

## Review 2026-07-29 (session) — docs review (文档锐评) + adversarial review (对抗性审查)

### Reviewer Status
- Reviewer A (Codex): skipped
- Reviewer B (DeepSeek): OK
- Reviewer C (Opus): OK

### Confirmed findings

---

### [SR-20260729-016] [MEDIUM] rem/skills/rem/reference/scripts.md — Missing `--drift` flag for crystallize.js

- **Category:** Bug
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Add `--drift` to the crystallize.js flags column in the reference table.

`crystallize.js` gained a `--drift` mode in this change (see diff in `rem/scripts/crystallize.js`), but the `scripts.md` reference still lists only `--check`, `--propose`, `--execute --distilled <paths>`, `--validate`. The usage line inside the script now shows `[--check|--drift|--propose|--validate|--execute]`.

---

### [SR-20260729-017] [HIGH] shared/lock.mjs — Lock release unconditionally unlinks the lockfile — a stolen-then-reacquired lock is deleted by the original holder, and stale-steal has a TOCTOU window that can unlink a live process's lock

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Write a unique token (pid+random) at acquire; on release, read the file and only unlink if the token still matches ours. On stale-steal, re-stat after unlink-failure and never unlink a file whose content we cannot verify.

Two interleavings break mutual exclusion: (1) Process A's critical section exceeds staleMs (60s, mtime is set only at openSync and never refreshed). B steals, unlinks, creates its own lock. A's finally block then runs unlinkSync(file) unconditionally — deleting B's live lock — and C waltzes in. Now B and C are both 'holding' the lock. (2) Classic stale-steal TOCTOU: A stats (stale), meanwhile the real holder releases and a fresh process D creates a new lockfile; A's unlinkSync then deletes D's brand-new lock and A acquires — A and D concurrent. The pid/timestamp written into the lockfile is never read back, so the code has everything needed to detect these cases and deliberately doesn't. For a lock whose entire job is preventing lost updates in state files, this is the worst failure mode: silent, rare, and exactly under the concurrency stress it was built for.

---

### [SR-20260729-018] [HIGH] rem/scripts/remember.js — remember.js writes flat `metadata.type: feedback` frontmatter, but prune/recall read nested `metadata.type` via the structured parser — type-based behavior (feedback 90d exemption, recall 2x weighting) may silently not apply to remember-created entries, and no test checks this

- **Category:** Bug
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Either write nested YAML (`metadata:\n  type: ...`) matching what prune-memory.js and recall.js parse, or add an integration test that creates an entry via remember.js and asserts prune-memory.js sees it as feedback-exempt and recall.js scores it with type weight 2.

remember.js line: `metadata.type: ${type}` in the generated frontmatter. prune-memory.js explicitly comments 'metadata.type is nested YAML — needs the structured parser, not the flat one' and reads `parseNestedFrontmatter(content)?.metadata?.type`; recall.js does the same. The prune tests seed files with genuinely nested YAML (`metadata:\n  type: feedback`), and the remember tests only regex-match the literal flat string in the output file — the two test suites never meet. Whether the shared parseFrontmatter normalizes dotted keys into nested objects is an unverified assumption the whole feedback-exemption feature rests on for the new primary write path. If it doesn't, every 'remember this: never do X' feedback memory loses its 90-day eviction protection and its recall boost with zero error.

---

### [SR-20260729-019] [HIGH] rem/hooks/rem-hook.js — null session_id fix is half-complete: two hooks that BOTH lack session_id still share state and leak remPending across sessions within the 30-min window

- **Category:** Bug
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** When inputKey is null, either always treat the session as fresh (skip session-key matching entirely and rely on a different discriminator like transcript_path or a per-invocation nonce), or refuse to carry remPending/remDone across invocations when storedKey is null.

The fix changed the guard to `storedKey != null && storedKey !== inputKey`, which handles null-vs-stored. But decideStop now persists `sessionKey: null` (the new test asserts exactly this). The next session whose hook input also lacks session_id — the exact population this bugfix targets (Codex/Claude variants emitting null session_id) — sees storedKey === null → guard skipped → not fresh → inherits remPending/remDone/stopCount from the previous unrelated session. The leak the commit claims to fix still occurs, just only for the null-null case. The test only covers null-vs-'s1', which is the conspicuously absent negation case.

---

### [SR-20260729-020] [HIGH] shared/state.mjs — saveState locks only the write phase — every load→mutate→save caller except appendEvent still races (lost updates), and unlocked readers can torn-read the non-atomic write; the comment overclaims protection

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Provide a locked updateState(stateFile, mutator) that does load+mutate+save inside one withLock and migrate rem-hook's decideStop, prune's state mutation, and any other load-then-save callers to it. Make atomic=true the default, or hold a read-side check (e.g. retry-on-parse-failure inside the lock) in loadState.

The header comment says 'The write phase is lease-locked against concurrent processes' — technically true and practically misleading. Two concurrent Stop hooks both loadState (unlocked), both mutate their own copy, both saveState: each write is serialized, but the second writer's payload was computed from a stale snapshot, so the first writer's changes vanish. The lock adds nothing here beyond what a single writeFileSync already gave; only appendEvent (which wraps load inside withLock) is actually protected. Worse: the default non-atomic path writeFileSync's payload while loadState in another process reads the same file with no lock and no retry — a torn read mid-write yields a JSON.parse failure that loadState presumably swallows into DEFAULT_STATE, silently resetting hook state. The code 'hopes' reads never coincide with writes.

---

### [SR-20260729-021] [MEDIUM] shared/lock.mjs — Timeout fallback proceeds WITHOUT the lock — under real contention the lock silently degrades into the exact lost-update race it was added to prevent, and the only signal is a console.warn nobody sees in a hook

- **Category:** Feature
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** At minimum, return/flag whether the lock was actually held so callers doing destructive read-modify-write (prune drops, crystallize index clears) can abort or retry rather than mutate unlocked. Consider failing closed for non-hook callers (CLI scripts) where blocking is acceptable.

The comment frames this as a feature ('never a reason to block a hook indefinitely'), but the tradeoff is unacknowledged where it matters: withLock is shared between latency-sensitive hooks (where proceed-unlocked is defensible) and batch scripts like prune-memory.js / crystallize.js --execute that drop entries and clear indexes — operations where running unlocked concurrently with another prune is precisely the corruption scenario this whole commit exists to fix. console.warn in a UserPromptSubmit/SessionStart hook goes to a log the user never reads; in the MCP/CLI case it scrolls past. There is no metric, no state-file breadcrumb, and no caller-level distinction between 'locked' and 'gave up'. The lock is best-effort in the worst place.

---

### [SR-20260729-022] [MEDIUM] rem/scripts/recall.js — Tokenizer keeps only [a-z0-9] — CJK prompts produce zero tokens, so recall silently never fires for Chinese/Japanese/Korean users (this repo's own memory files and user prompts are heavily Chinese)

- **Category:** Bug
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Extend tokenize to keep CJK characters (e.g. split on /[^\p{L}\p{N}]+/u with a lower min length for CJK, or bigram CJK runs), and add a test with a Chinese prompt matching a Chinese-named memory.

`split(/[^a-z0-9]+/)` plus `tok.length < 3` means '记住这个约定' tokenizes to [] — main() then returns silently ('no tokens'). The project's own committed memory file is in Chinese, the user says '记住这个' in the docs, and memory-conventions.md explicitly documents the Chinese trigger phrase — yet the recall hook can never recall anything for those prompts. This is a blind spot created by testing only with English fixtures ('git commit messages'). The failure mode is perfectly silent: exit 0, no output, feature simply absent for a whole language family.

---

### [SR-20260729-023] [MEDIUM] rem/scripts/remember.js — Frontmatter generation does no YAML escaping: --description (or a derived first line) containing newlines/colons breaks frontmatter, and a newline in description injects arbitrary frontmatter keys — bypassing the volatile-field guard

- **Category:** Bug
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Reject 
 and  in --description and in the derived desc line; quote/escape the value (or JSON.stringify-compatible YAML quoting) before interpolating into the frontmatter template.

The volatile-field guard (VOLATILE_RE) is applied only to body, but `description: ${desc}` is interpolated raw. `--description $'x\naccessed: 2020-01-01'` writes a frontmatter containing `accessed:` — the exact volatile field the guard exists to keep out of files — and remember.js happily stamps it. More mundanely, a derived desc like 'Fix: use double quotes' (colons are common in first lines, and desc is auto-derived from body when --description is omitted) produces `description: Fix: use double quotes`, which is invalid YAML and may make the strict parseNestedFrontmatter in prune/recall fail or mis-parse the whole block — silently degrading type classification again. The agent invoking this CLI composes free text; assuming it's YAML-safe is overconfidence in caller behavior.

---

### [SR-20260729-024] [MEDIUM] shared/lock.mjs — Staleness is judged from lockfile creation mtime and never refreshed — any critical section longer than 60s is considered crashed and its lock stolen mid-hold

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Either touch (utimes) the lockfile periodically during long critical sections, or treat a lock whose owning pid is alive as non-stale regardless of age (pid liveness check via process.kill(pid, 0), with cross-platform caveat), or raise staleMs well above the worst-case critical section.

prune-memory.js wraps demotions + per-entry saveMemoryMeta + rebuildIndex for ALL scopes inside one prune-wide lock; on a slow filesystem (the user's repo sits on OneDrive, per the repo path) with many entries this can plausibly exceed 60s. At that point a second SessionStart hook on the same host steals the lock mid-mutation, and both prunes interleave saveMemoryMeta/rebuildIndex — the exact multi-process corruption the lock was added to prevent, now with extra steps. The code assumes critical sections are always sub-minute; nothing enforces or even measures that assumption.

---

### [SR-20260729-025] [MEDIUM] rem/scripts/recall.js — Every UserPromptSubmit synchronously reads frontmatter of every memory file (loadMemoryState + per-file readFileSync) — on OneDrive/cloud-placeholder files or large memory stores this can blow the 5s hook budget and stall every prompt

- **Category:** Performance
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Cache candidates keyed by (scopeRoot, max mtime of memory dir) in a small JSON under the state dir, or score from the MEMORY.md index + _meta.json descriptions instead of opening every file; only read bodies for winners (already done). Add a timing guard that aborts recall past a soft deadline.

collectCandidates walks the whole memory tree and opens each .md on every single prompt, synchronously, on the critical path of prompt submission. The '<200ms' claim in the header is wishful thinking measured against a warm local disk: the repo itself lives in a OneDrive folder where files may be cloud placeholders (first open triggers a network fetch), and the user's own AGENTS.md advertises multi-device sync. There is no caching layer, no file-count cap, and the latency test uses 30 tiny local files with a 'generous CI bound' of 2000ms that includes node startup — it would not catch the pathological case. Failure mode is user-visible lag on every keystroke-enter, the worst place for it.

---

### [SR-20260729-026] [MEDIUM] fabric/engine/providers.mjs — ANTHROPIC_AUTH_TOKEN and ANTHROPIC_API_KEY are treated as interchangeable, but they carry different auth semantics downstream (Bearer token vs x-api-key) — accepting either blindly may mis-authenticate

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Record which env var supplied the token in the resolved result and pass it through to the spawned CLI under the same variable name, instead of normalizing both into one `token` field whose downstream emission is assumed uniform.

In Claude Code, ANTHROPIC_AUTH_TOKEN and ANTHROPIC_API_KEY are not aliases: the former goes to an Authorization: Bearer header, the latter to x-api-key, and providers/proxies frequently accept only one. The diff collapses them into `result.token` without recording provenance; if the spawn layer re-exports it under a fixed variable name, a provider configured with API_KEY semantics will be launched with Bearer semantics (or vice versa) and fail with a confusing 401 — or worse, partially work. The new test only asserts the config loads, not that the auth actually reaches the wire correctly. This is an implicit assumption about downstream behavior introduced to fix one provider (kimi) without validating the mechanism end-to-end.

---

### [SR-20260729-027] [MEDIUM] rem/scripts/recall.js — Lock claims to guard 'on both hosts' but lockfiles in a OneDrive-synced memory dir give false cross-device safety — sync latency means two machines can both create the 'exclusive' lockfile

- **Category:** Feature
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Document explicitly that the lock is same-host only (or move lockfiles to a per-host tmpdir keyed by scope path hash). If cross-device exclusion is actually needed, it requires a different mechanism (cloud-synced files cannot provide it).

openSync(path, 'wx') provides atomic exclusive create only on a coherent local filesystem. The target files live under .claude/memory/ which — per this repo's own location and docs — syncs via OneDrive across machines. Device A creates X.lock; OneDrive hasn't propagated it; device B creates X.lock locally too; both proceed. When OneDrive later reconciles, it may even create 'X-COPY.lock' conflict files that the stale-detection then treats as garbage. The header comment 'Guards ... against concurrent hook/script runs on both hosts' invites exactly the wrong inference for the multi-device setup the project advertises.

---

### [SR-20260729-028] [LOW] shared/lock.mjs — stat-failure retry path has no sleep and no deadline check — a churning lockfile (created/deleted rapidly by another process) can spin the loop indefinitely

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Check the deadline (or at least sleep retryMs) on the `catch { continue; }` stat-failure path as well, so every loop iteration is bounded.

In the EEXIST branch, `try { mtime = statSync(...) } catch { continue; }` loops immediately without sleepMs and without evaluating `Date.now() >= deadline`. Under normal conditions the next openSync succeeds, but if another process rapidly releases and reacquires (or AV/OneDrive flickers the file), this path can busy-spin past timeoutMs — the deadline is only consulted on the fresh-lock path. Low probability, but the loop invariant ('every iteration either acquires, sleeps, or times out') is violated on exactly one branch.

---

### [SR-20260729-029] [LOW] shared/state.mjs — appendEvent no longer returns the {persisted} result of its inner saveState — a silent API regression for any caller that inspected it

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** `return withLock(...)` in appendEvent, or document the signature change.

Previously appendEvent returned saveState's return value; now it returns undefined because the withLock(...) expression statement isn't returned. The codebase's own convention (saveState returns {persisted} so callers can fall back to in-memory state) suggests at least one caller class cares about persistence outcomes; nothing in the diff audits appendEvent callers for this.

---

### [SR-20260729-030] [LOW] shared/tests/lock.test.mjs — The lock's entire raison d'être — cross-process mutual exclusion — is never tested: all tests are single-process, and the two races that matter (steal-while-held, concurrent saveState lost update) have no coverage

- **Category:** Feature
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Add a test spawning two child node processes that contend on one lock with interleaved critical sections and assert serialized modification of a shared counter file; add a test that a >staleMs critical section does not corrupt a second acquirer's lock.

49 new tests and not one exercises two OS processes. The tests verify reentrancy, stale-steal in-process, and timeout fallback — the easy paths — while the commit message's core claim (防多会话/多设备竞态) rests on behavior that only manifests across processes with real timing. The conspicuously absent tests are exactly the ones that would catch finding #1. This is test theater around the riskiest new primitive.

---

### [SR-20260729-031] [INFO] rem/scripts/prune-memory.js — Entries demoted from long→short this run immediately become eligible for the capacity cap and can be dropped in the same run, without the distinction being logged

- **Category:** Feature
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Log separately when a just-demoted entry is also cap-dropped, or give freshly demoted entries one cycle of grace before cap eligibility.

Demoted entries are pushed into shortTerm before `over`/`toDrop` is computed, and since demotion implies stale access dates, they sort oldest-first and are the first dropped. That may be intended ('demote then prune'), but a long-term entry the user explicitly promoted can go from long→short→dropped in a single SessionStart with only a generic 'over-capacity' tombstone — no audit trail that it transited through demotion seconds earlier. Silent tradeoff between cap enforcement and user intent.

---

### [SR-20260729-032] [INFO] rem/scripts/recall.js — Six byte-identical copies of lock.mjs (and re-copied state/stamp) across plugins will drift on the next fix — there is no single source of truth or sync check

- **Category:** Feature
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Add a CI check (checksum comparison) that all bundled shared/*.mjs copies are identical, or a sync script; otherwise the next lock bugfix will land in rem/ and silently miss fabric/, watch/, traceme/, sharp-review/, evolve/.

The diff itself demonstrates the pattern: one lock.mjs copied six times verbatim. Any future fix to the steal/release race or staleness logic must be replicated six ways by hand. The repo already had this problem with state.mjs/stamp.mjs (identical files), and nothing in this commit adds a guard against the copies diverging.


## Review 2026-07-29 (follow-up)

## Review 2026-07-29 (session) — docs review (文档锐评) + adversarial review (对抗性审查)

### Reviewer Status
- Reviewer A (Codex): OK
- Reviewer B (DeepSeek): OK
- Reviewer C (Opus): skipped

### Confirmed findings

---

### [SR-20260729-033] [HIGH] rem/skills/rem/reference/memory-conventions.md — remember.js emits flat `metadata.type:` frontmatter, but prune's feedback exemption and recall's type weighting only read nested `metadata: type:` — the documented feedback-save path silently opts out of both features

- **Category:** Bug
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Fix remember.js to write nested YAML (`metadata:\n  type: <type>`) matching the format prune-memory.js parses, or make the shared parseFrontmatter handle the flat dotted key; update remember.test.mjs accordingly

memory-conventions.md presents remember.js as the immediate-save path for all four types and stresses `feedback` semantics ('ONLY for behaviors the user explicitly corrected'). But remember.js writes `metadata.type: ${type}` as a flat dotted key (asserted verbatim in remember.test.mjs: `metadata\.type: feedback`), while prune-memory.js explicitly requires the structured nested parser for the feedback exemption ('metadata.type is nested YAML — needs the structured parser, not the flat one'; prune tests seed nested `metadata:\n  type: feedback`). recall.js's collectCandidates likewise reads `fm.metadata?.type`. A feedback memory saved via the documented remember.js path will therefore NOT be exempt from the 90-day stale eviction documented in prune-memory.js's header, and gets no user/feedback ×2 recall weight — the docs promise behavior the pipeline can't deliver for remember.js-written files.

---

### [SR-20260729-034] [MEDIUM] rem/skills/rem/reference/crystallize.md — Docs promise a `dropped: 'drifted'` tombstone reason that no code path writes

- **Category:** Bug
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Either implement a drift-drop path in crystallize.js --execute (e.g. accept per-path reasons and pass 'drifted' to dropFromIndex) or reword the doc to state that drift-drops are recorded as 'crystallized' like all other drops

The new step 0 says: 'When the user confirms a drift-drop, its tombstone reason in _meta.json is dropped: "drifted" (distinct from "crystallized")'. In crystallize.js --execute, every drop goes through `dropFromIndex(scopeRoot, p, 'crystallized')` with the reason hardcoded — there is no flag or branch that writes 'drifted'. An agent following this doc will expect a 'drifted' tombstone that never materializes, and any future tooling filtering on that reason would find nothing.

---

### [SR-20260729-035] [MEDIUM] rem/skills/rem/reference/scripts.md — crystallize.js row omits the new --drift flag despite this being the 'full table with all scripts and flags'

- **Category:** Bug
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Add `--drift` to the crystallize.js Key Flags column (e.g. `--check`, `--drift`, `--propose`, `--execute --distilled <paths>`, `--validate`)

SKILL.md points here as the 'full table with all scripts and flags', and crystallize.js's own usage string now reads `[--check|--drift|--propose|--validate|--execute]`. The table lists only `--check`, `--propose`, `--execute --distilled <paths>`, `--validate` — stale one commit after the flag shipped. The flag is only discoverable via reference/crystallize.md, which an agent consulting the scripts table would not necessarily open.

---

### [SR-20260729-036] [LOW] rem/skills/rem/reference/scripts.md — prune-memory.js description omits the new feedback exemption from 90-day stale eviction

- **Category:** Feature
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Update the usage column to note: feedback-type entries are exempt from the 90d stale eviction but still count toward the 20-entry cap

The row still says 'Enforce 20-entry cap + 90d eviction (short-term only, long-term protected)'. prune-memory.js now has type-aware retention (staleEvictable/staleExempt split, 'stale feedback entries exempt' log line, header comment documenting the exemption). The doc understates the behavior and contradicts the script's own header comment.

---

### [SR-20260729-037] [INFO] rem/skills/rem/reference/crystallize.md — New drift-verification step is numbered '0' ahead of existing step 1, and --drift is described as listing 'every tier: long entry' while the code also filters dropped and tasks/ entries

- **Category:** Bug
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Renumber the steps so the flow reads 1→N, and qualify the --drift output description as 'every non-dropped, non-task tier: long entry'

Inserting a step '0.' before the pre-existing '1.' leaves the procedure with an odd 0,1,2,3 sequence. Minor accuracy point: crystallize.js --drift skips `meta.dropped` and `tasks/` paths, so 'every tier: long entry' slightly overclaims — harmless in practice but the doc is the contract for the verifying model.

---

### [SR-20260729-038] [HIGH] shared/lock.mjs — Lockfile lease has no renewal mechanism; holders never update mtime, so any operation longer than staleMs (60s) is vulnerable to premature stealing, enabling concurrent mutations.

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Require holders to periodically `utimesSync` the lockfile to refresh mtime, or switch to a pid-based ownership check with explicit heartbeat.

The lockfile's mtime is set once at creation and never touched again. If a prune or crystallize takes >60 seconds, the mtime becomes stale, and another process will steal the lock, causing two processes to operate on the same shared state/index simultaneously. The comment claims the steal handles crashed holders, but a live holder with long runtime is indistinguishable from a crashed one. This directly contradicts the goal of safe read-modify-write sections.

---

### [SR-20260729-039] [HIGH] rem/scripts/prune-memory.js — Drop decisions (stale list, capacity eviction) are made outside the lock, creating a classic TOCTOU race with concurrent prunes.

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Move the entire decision logic (reading state, classifying stale, computing dropSet) inside the lock-protected critical section, or re-read state after acquiring the lock.

The code reads the memory state and builds `dropSet` before `withLock('.prune', ...)`. A concurrent prune could have already dropped some of those entries, leading to double dropping, or new entries could have been added, causing the capacity cap to be exceeded. The lock should guard the full read-decide-write cycle.

---

### [SR-20260729-040] [HIGH] rem/scripts/crystallize.js — Indexed paths for --execute are collected before the index lock, so the list may be stale when the lock is acquired, risking inconsistent drops.

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Read `indexedPaths` inside the lock after acquiring it, or accept that the lock only serialises the mutation and re-read the index after lock is held.

In `--execute`, `indexedPaths` and `distilledPaths` are determined from file existence and parsing before `withLock(indexFile, ...)`. Between that point and lock acquisition, another process could crystallise the same entries, causing the lock-holder to drop paths that no longer exist (spurious `dropFromIndex`) or miss new entries.

---

### [SR-20260729-041] [MEDIUM] rem/scripts/remember.js — remembers.js writes `metadata.type` as a flat dotted YAML key, but prune-memory.js expects nested YAML structure; feedback exemption will silently fail for these entries.

- **Category:** Bug
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Make remember.js output proper nested YAML (e.g., `metadata:
  type: feedback`) so that the nested parser in prune-memory.js can read the type.

remember.js produces frontmatter like `metadata.type: feedback`. prune-memory.js reads it with `parseNestedFrontmatter(content)?.metadata?.type`, which expects `metadata:` to be an object with a `type` key. A flat key `metadata.type` is not parsed as a nested property, so `type` stays `null` and feedback entries lose their staleness exemption.

---

### [SR-20260729-042] [MEDIUM] rem/scripts/recall.js — Tokenization splits on `[^a-z0-9]+`, silently dropping all non-ASCII (e.g., Chinese, emoji) tokens — recall becomes English-only with no warning.

- **Category:** Bug
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Either support Unicode script detection or document/fallback gracefully. Consider `\p{L}` with a flag, or at least emit a debug note if the prompt appears non-ASCII.

Using `/[^a-z0-9]+/` as split will treat any non-ASCII character as separator; CJK text like `'你好世界'` will result in no tokens ≥3 chars, so no recall occurs. The feature is marketed as 'heuristic recall' but silently fails for many Claude Code users using non-English prompts.

---

### [SR-20260729-043] [MEDIUM] shared/lock.mjs — On lock acquisition timeout, the critical function is still executed without any guard, turning the lock into a strictly best-effort mechanism that provides zero protection under contention.

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Either fail the operation explicitly when lock cannot be obtained (so that the caller knows consistency is at risk), or implement a persistent lock with exponential backoff that never falls back to unprotected execution.

The docstring says 'a lock is a best-effort guard, never a reason to block a hook indefinitely', but when two processes both hit the timeout simultaneously (e.g., during heavy prune load), they both proceed without a lock. This can lead to corrupted state, duplicated index entries, or lost events — exactly the scenario the lock was introduced to prevent.

---

### [SR-20260729-044] [LOW] shared/state.mjs — Writers are serialized but readers (loadState) are not; non-atomic writes (default) can leave a partially written file visible to concurrent readers, causing JSON parse errors.

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Either make `saveState` always atomic when a lock is used, or enforce that all readers also acquire a shared lock (or use the atomic rename path consistently).

`saveState` defaults to `atomic: false` and uses direct `writeFileSync`. Another process reading via `loadState` (e.g., a hook) while a write is in progress may read a truncated or partially written file. The lock only coordinates writers; readers still race.

---

### [SR-20260729-045] [INFO] shared/lock.mjs — Atomics.wait blocks the event loop; while acceptable for short retries in a child process, any external inclusion of lock.mjs in the main event loop of a plugin runner will freeze the process.

- **Category:** Performance
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Guard `Atomics.wait` with a check that `require('worker_threads').isMainThread` is false, or switch to a non-blocking poll (e.g., setTimeout with Promises) if ever used in a long-lived process.

The comment assumes the lock is only used in sync CLI scripts that are short-lived. If the module is ever imported into a process that also handles other requests, the 50 ms blocking sleep will starve the event loop.


## Review 2026-07-29 (follow-up)

## Review 2026-07-29 (session) — docs review (文档锐评)

### Reviewer Status
- Reviewer A (Codex): skipped
- Reviewer B (DeepSeek): skipped
- Reviewer C (Opus): OK

### Confirmed findings

---

### [SR-20260729-046] [HIGH] rem/skills/rem/reference/memory-conventions.md — Docs use `access_count` but the `_meta.json` field is `count` — wrong name still shipped after a prior review flagged it

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Rename every `access_count` reference to `count` in memory-conventions.md (L39-40), standard-procedure.md (L24,25,59) and crystallize.md (L41,44), or rename the code field once and update all docs.

rem/scripts/lib.mjs bumpAccessed writes `count`; grep for `access_count` across rem/scripts/*.js returns zero hits. Docs instruct agents to read and act on a field that does not exist, so anything following memory-conventions.md verbatim reads undefined. The 2026-06-25 sharp-review memory recorded this exact mismatch — never fixed.

---

### [SR-20260729-047] [MEDIUM] rem/skills/rem/reference/memory-conventions.md — Promotion documented three different ways across three files

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** State one authoritative promotion path — automatic on `count >= 3` during bumpAccessed, with `touch-memory.js --promote` as the manual override — and drop or qualify the `rem-prep.js --promote` claim.

L41 says `rem-prep.js --promote` automatically sets `tier: long`; L64 says promotion happens automatically once `count >= 3` or manually via `touch-memory.js --promote`; scripts.md documents only `touch-memory.js --promote`. Three docs, three mechanisms for one behavior.

---

### [SR-20260729-048] [MEDIUM] sharp-review/agents/sharp-review.md — Runtime plugin-cache copy still hardcodes the 3-reviewer seed%3 roster the repo replaced with dynamic list_providers rotation

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Bump the sharp-review plugin version so the cache refreshes to the dynamic-roster definition; add a test asserting agents/sharp-review.md contains no hardcoded reviewer table.

Repo agents/sharp-review.md and reference/direct-fanout.md define `providers[seed % N]` / `providers[(seed+1) % N]` from fabric list_providers. The copy that actually executes still says `seed % 3` over a fixed Codex/DeepSeek/Opus roster, so it picks providers that may not be configured — this run selected DeepSeek, which has no ANTHROPIC_AUTH_TOKEN and hard-failed.

---

### [SR-20260729-049] [MEDIUM] sharp-review/skills/sharp-review/reference/direct-fanout.md — Rotation docs treat list_providers output as the eligible set, but listed providers can be unusable (missing auth token)

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Document that a listed provider may still fail with 'missing ANTHROPIC_AUTH_TOKEN', and require rotation to advance to the next provider index instead of recording a null reviewer.

fabric list_providers enumerates deepseek/kimi from claude_env_settings.json regardless of token presence; providers.mjs only throws at call time (L91). A token-less provider therefore silently burns one of the two reviewer slots with no documented recovery.

---

### [SR-20260729-050] [LOW] fabric/README.md — Auth section explains token precedence but never names the config file a failing user must edit

- **Category:** Feature
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Add the exact error string ('Provider "X" is missing ANTHROPIC_AUTH_TOKEN or ANTHROPIC_API_KEY in <path>') and point at ~/.claude/claude_env_settings.json.

README L138 covers ANTHROPIC_AUTH_TOKEN → Bearer vs ANTHROPIC_API_KEY → x-api-key, but a user hitting the providers.mjs L91 throw has no doc telling them where the config lives or which key to add.

---

### [SR-20260729-051] [LOW] shared/lock.mjs — New locking contract is documented nowhere a skill can see at runtime

- **Category:** Feature
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Document withLock's options (staleMs 60000, retryMs 50, timeoutMs 5000) and the onTimeout policy split ('throw' in lock.mjs vs 'proceed' in state.mjs/stamp.mjs) in a reference/*.md, not only in dev-only rules files.

shared/lock.mjs exports withLock with four tuned defaults and two distinct timeout policies; state.mjs and stamp.mjs each default to 'proceed'. No SKILL.md or reference/*.md explains when a lock timeout silently proceeds versus throws, so callers cannot reason about partial writes. invariants.md is dev-context only and per the repo's own rule must not be where a runtime fact lives.


## Review 2026-07-29 (follow-up)

## Review 2026-07-29 (session) — docs review (文档锐评)

### Reviewer Status
- Reviewer A (Codex): skipped
- Reviewer B (DeepSeek): FAILED
- Reviewer C (Opus): OK
- Warning: only 1/2 reviewers succeeded

### Confirmed findings

---

### [SR-20260729-052] [HIGH] rem/skills/rem/reference/state-schema.md — state-schema.md is two schema revisions behind: missing `version` and `docs`, and documents a `scopes.split` block that does not exist

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Regenerate the JSON block from DEFAULT_STATE verbatim, delete the fabricated scopes.split, and document withStateLock(stateFile, fn, {onTimeout, atomic}) as the required read-modify-write API.

shared/state.mjs DEFAULT_STATE has version:1, hook, prune, scopes:{ignore}, docs:{roots,anchors} (state.mjs:11-51). The reference JSON omits version and the entire docs key (the storage backend for /refresh-docs freshness anchors) and invents scopes.split with minOwnEntries/minClusterEntries/maxBytes — never written or read anywhere. It also claims state lives behind lib.mjs loadState/saveState/appendEvent while the concurrency-safe entry point is withStateLock from shared/state.mjs (prune-memory.js:15,170). An agent following this file will clobber the docs anchors.

---

### [SR-20260729-053] [HIGH] rem/skills/rem/reference/scripts.md — Script table omits recall.js, doc-freshness.js and inject-rules.js despite claiming to be the full reference

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Add rows for recall.js, doc-freshness.js (incl. --set-anchor and exit-1 semantics) and inject-rules.js, or drop the 'all flags' claim in SKILL.md:41.

rem/scripts/ contains 15 files; the table lists 11 and misses recall.js (the UserPromptSubmit auto-recall hook, documented only in README/AGENTS.md which are NOT visible at skill runtime), doc-freshness.js (invoked by standard-procedure.md:12 and SKILL.md:85 with no flag reference; takes --set-anchor <relPath> per doc-freshness.js:234) and inject-rules.js. SKILL.md:41 advertises this table as the full script reference (all flags), so the gap is a broken promise.

---

### [SR-20260729-054] [HIGH] rem/skills/investigate/SKILL.md — investigate/SKILL.md prescribes `metadata.type: research` — not a valid type; rejected by remember.js and mis-weighted by recall.js

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Either add `research` to TYPES in remember.js plus the conventions/recall weighting tables, or change the skill to `project` and have it call remember.js --type project --name … --body -.

SKILL.md:16 prescribes metadata.type: research. remember.js:22 TYPES = {user, feedback, project, reference} hard-rejects anything else; memory-conventions.md lists the same four; recall.js:197 weights only user/feedback x2. Every investigate output lands as an unrecognized type: it can never be created via remember.js and silently loses recall weighting and the feedback prune exemption. The skill also has the agent hand-write frontmatter instead of calling remember.js.

---

### [SR-20260729-055] [HIGH] rem/skills/rem/reference/memory-conventions.md — Docs use `access_count` but the `_meta.json` field is `count` — wrong name still shipped after a prior review flagged it

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Rename every `access_count` reference to `count` in the three docs, or rename the code field once and update all docs.

rem/scripts/lib.mjs bumpAccessed writes `count`; grep for `access_count` across rem/scripts/*.js returns zero hits. Docs instruct agents to read and act on a field that does not exist, so anything following memory-conventions.md verbatim reads undefined. The 2026-06-25 sharp-review memory recorded this exact mismatch — never fixed. Affects memory-conventions.md L39-40, standard-procedure.md L24,25,59 and crystallize.md L41,44.

---

### [SR-20260729-056] [MEDIUM] rem/skills/rem/reference/memory-conventions.md — Promotion documented three different ways across three files

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** State one authoritative promotion path — automatic on count >= 3 during bumpAccessed, with touch-memory.js --promote as the manual override — and drop or qualify the rem-prep.js --promote claim.

L41 says `rem-prep.js --promote` automatically sets tier: long; L64 says promotion happens automatically once count >= 3 or manually via `touch-memory.js --promote`; scripts.md documents only `touch-memory.js --promote`. Three docs, three mechanisms for one behavior.

---

### [SR-20260729-057] [MEDIUM] rem/skills/rem/reference/scripts.md — Nothing documents that mutating scripts now fail CLOSED with exit 1 on lock timeout

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Add a 'Concurrency & exit codes' section to scripts.md: mutating scripts fail closed (exit 1) on a 5s lock timeout and are safe to retry; hooks proceed unlocked with a warning. Include withLock's option defaults.

shared/lock.mjs added a cross-process lease lock with caller-chosen timeout policy; every mutating CLI passes onTimeout:'throw' (prune-memory.js:158-188, crystallize.js:208-225, stamp-memory.js:40-48) and exits 1 on LockTimeoutError, while hooks default to 'proceed' and warn. An agent seeing exit 1 has no documented way to distinguish lock contention (retry) from real failure (stop) — the only description is a comment in lock.mjs, not loaded at skill runtime. Tuned defaults (staleMs 60000, retryMs 50, timeoutMs 5000) are likewise undocumented anywhere a skill can see.

---

### [SR-20260729-058] [MEDIUM] fabric/README.md — The 'Why' section still justifies the observe proxy with a DeepSeek-Foundry conflict that no longer exists

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Rewrite 'Why' provider-agnostically; keep Foundry as a supported-but-not-default example; change 'Foundry direct' to 'direct'.

README.md:66-84 frames the design rationale as 'the child direct-connects to its provider (DeepSeek via Foundry env)' and 'claude-tap only intercepts vanilla ANTHROPIC_BASE_URL, which conflicts with Foundry routing (DeepSeek)'. DeepSeek migrated off Foundry to the direct Anthropic-compatible style; providers.mjs:80-91 keeps Foundry as a generic branch but not as the DeepSeek path. The motivating example is false and sends readers hunting for ANTHROPIC_FOUNDRY_* vars that are not set. README.md:83/100 and fabric/AGENTS.md's buildChildEnv note repeat 'Foundry direct' where it is just 'direct'.

---

### [SR-20260729-059] [MEDIUM] fabric/README.md — The `fable` model tier is fully implemented but appears in zero markdown files repo-wide

- **Category:** Feature
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Document the four tiers and the ANTHROPIC_DEFAULT_*_MODEL keys in fabric/README.md, and state the resolveModelFromId fallback order explicitly.

providers.mjs:118 maps fable -> defaultFable in TIER_MAP, resolveModelFromId matches it (providers.mjs:138) and uses it as the FIRST fallback for any unmatched model id (defaultFable || defaultOpus || defaultSonnet || fullId, providers.mjs:141); listModels surfaces fable= from ANTHROPIC_DEFAULT_FABLE_MODEL (providers.mjs:178). A repo-wide grep for 'fable' across *.md returns nothing. Users cannot discover the tier, cannot know ANTHROPIC_DEFAULT_FABLE_MODEL is a recognized key, and cannot predict that setting it silently changes the fallback target for every unrecognized model id.

---

### [SR-20260729-060] [MEDIUM] sharp-review/agents/sharp-review.md — Runtime plugin-cache copy still hardcodes the 3-reviewer seed%3 roster the repo replaced with dynamic list_providers rotation

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Bump the sharp-review plugin version so the cache refreshes to the dynamic-roster definition; add a test asserting agents/sharp-review.md contains no hardcoded reviewer table.

Repo agents/sharp-review.md and reference/direct-fanout.md define providers[seed % N] / providers[(seed+1) % N] from fabric list_providers. The copy that actually executes still says seed % 3 over a fixed Codex/DeepSeek/Opus roster, so it picks providers that may not be configured — this run selected DeepSeek, which has no ANTHROPIC_AUTH_TOKEN and hard-failed.

---

### [SR-20260729-061] [MEDIUM] sharp-review/skills/sharp-review/reference/direct-fanout.md — Rotation docs treat list_providers output as the eligible set, but listed providers can be unusable (missing auth token)

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Document that a listed provider may still fail with 'missing ANTHROPIC_AUTH_TOKEN', and require rotation to advance to the next provider index instead of recording a null reviewer.

fabric list_providers enumerates deepseek/kimi from claude_env_settings.json regardless of token presence; providers.mjs only throws at call time (L91). A token-less provider therefore silently burns one of the two reviewer slots with no documented recovery.

---

### [SR-20260729-062] [MEDIUM] fabric/AGENTS.md — Bundled-shared inventory lists 5 files and omits lock.mjs, which bundle-integrity enforces

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Change to (spawn/lib/state/stamp/attention/lock) and note the inventory is machine-enforced by tests/bundle-integrity.test.mjs.

fabric/AGENTS.md:46 says shared/ bundles (spawn/lib/state/stamp/attention). The actual bundle is 6 files — fabric/shared/lock.mjs exists and tests/bundle-integrity.test.mjs asserts every *.mjs under cc-market/shared/ is byte-identical in each plugin bundle. A developer trimming to match this list breaks the test; the omission also hides that a shared/lock.mjs edit fans out to fabric. rem/AGENTS.md:94 has the same blind spot.

---

### [SR-20260729-063] [MEDIUM] rem/scripts/lib.mjs — Generated MEMORY.md header teaches the flat `metadata.type:` frontmatter that memory-conventions.md says is silently broken

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Change the header to the nested metadata:/type: form and note a flat dotted key is not parsed. Same fix applies to investigate/SKILL.md:16.

INDEX_HEADER (lib.mjs:300) documents frontmatter as a flat dotted `metadata.type:` key. memory-conventions.md:52-59 states this form is invisible to prune-memory.js and recall.js's structured parser and silently drops the feedback exemption / recall weighting; remember.js:87-90 emits the nested form with a comment warning against exactly this. INDEX_HEADER is written into every scope's always-injected .claude/rules/MEMORY.md, making this the most-read frontmatter spec in the system — and it contradicts the convention it enforces.

---

### [SR-20260729-064] [MEDIUM] AGENTS.md — The 'run every JS suite manually' command silently skips shared/tests and tests/bundle-integrity.test.mjs

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Replace the tail with cc-market/shared/tests/*.test.mjs cc-market/tests/*.test.mjs.

AGENTS.md:39 lists fabric/rem/sharp-review/evolve/traceme tests plus tests/gen-codex.test.mjs under the heading 'To run every JS suite manually'. It omits cc-market/shared/tests/*.test.mjs (6 suites: attention, lib, lock, spawn, stamp, state — the entire lock coverage) and cc-market/tests/bundle-integrity.test.mjs. The same section says staging anything under shared/ fans out to all plugins, so a developer touching shared/lock.mjs runs this, sees green, and has tested none of the lock's own suite.

---

### [SR-20260729-065] [LOW] rem/README.md — recall.js tmpdir candidate cache and the rem-locks tmpdir directory are undocumented device-local side effects

- **Category:** Feature
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Add a 'Device-local artifacts' note to rem/README.md listing both paths, the invalidation rule (stat fingerprint / 60s stale-steal), and that deleting them is safe.

recall.js:159-177 writes a per-scope candidate cache to os.tmpdir()/rem-recall-<key>.json keyed by a stat fingerprint. shared/lock.mjs lockFilePath writes every lockfile to os.tmpdir()/rem-locks/<sha256-prefix>.lock — deliberately device-local so a OneDrive-synced lockfile cannot mutex across hosts, explained only in a code comment. Neither appears in rem/README.md, rem/AGENTS.md or any reference/*.md, so a user debugging stale recall output or a wedged lock has no documented place to look and no documented remedy.

---

### [SR-20260729-066] [LOW] .claude/rules/rem/hook.md — Always-injected hook rule still lists an already-fixed state-carryover bug under 'Known issues'

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Delete the 'State carryover bug' bullet; keep the background_tasks/taskActiveUntil guidance, which still matches the code.

hook.md claims remPending leaks across sessions when input.session_id is null, with a 'Fix: treat null session ID as always-different'. That fix shipped: rem-hook.js:62-77 derives inputKey = input.session_id ?? input.transcript_path ?? null and falls back to a per-process FALLBACK_SESSION_KEY so sessions cannot collide on a shared null key. Because the rule file is always injected, every session pays context for a stale bug report plus an instruction that would duplicate existing logic if followed.

---

### [SR-20260729-067] [LOW] rem/skills/rem/reference/crystallize.md — Inline node -e drift-drop snippet omits the fail-closed lock option and passes the wrong first argument

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Pass scopeRoot explicitly, add {onTimeout:'throw'}, follow with m.rebuildIndex(scopeRoot, {onTimeout:'throw'}) — or add a --drop-drifted flag to crystallize.js and delete the inline node -e.

crystallize.md step 1 calls m.dropFromIndex(m.findMemoryScope(), '<path>', 'drifted') with three args. dropFromIndex(scopeRoot, relPath, reason, opts) (lib.mjs:272) forwards opts to saveMemoryMeta and every in-repo mutating caller passes {onTimeout:'throw'} (crystallize.js:208,214; prune-memory.js:164,174). Omitting it silently defaults to 'proceed' — writing the tombstone without the lock, exactly the race the lock was added for. Also findMemoryScope() returns the scope descriptor while dropFromIndex expects scopeRoot, and the snippet never calls rebuildIndex, so the drifted entry stays visible in MEMORY.md until the next stamp.

---

### [SR-20260729-068] [LOW] fabric/README.md — Auth section explains token precedence but never names the config file a failing user must edit

- **Category:** Feature
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Add the exact error string and point at ~/.claude/claude_env_settings.json.

README L138 covers ANTHROPIC_AUTH_TOKEN -> Bearer vs ANTHROPIC_API_KEY -> x-api-key, but a user hitting the providers.mjs L91 throw has no doc telling them where the config lives or which key to add.

---

### [SR-20260729-069] [INFO] shared/lock.mjs — Typo in the lock.mjs header comment explaining device-local lockfiles

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Fix in cc-market/shared/lock.mjs and re-run the bundle sync so the copies match.

The header paragraph explaining why lockfiles live in os.tmpdir() misspells 'mutex'. Trivial, but this comment is the only written record of the device-local-lockfile rationale, and byte-identical bundling duplicates it into all 6 plugin bundles.


## Review 2026-07-29 (follow-up)

## Review 2026-07-29 (session) — docs review (文档锐评)

### Reviewer Status
- Reviewer A (Codex): skipped
- Reviewer B (DeepSeek): skipped
- Reviewer C (Opus): OK

### Confirmed findings

---

### [SR-20260729-070] [HIGH] README.md — Root README still documents and instructs installing the `takeover` plugin, which no longer exists — the directory is gone, it is absent from marketplace.json, and its link is broken.

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Delete the `takeover` row from the plugin table, replace `codex plugin add takeover@cc-market` and `/plugin install takeover@cc-market` with `fabric`, and add the missing `evolve` install line.

`takeover/` does not exist at repo root; `cc-market/AGENTS.md` says fabric absorbed the former takeover plugin. Yet README.md:23 links `[takeover](takeover/README.md)` (dead link), README.md:49 tells Codex users `codex plugin add takeover@cc-market`, and README.md:57 tells Claude users `/plugin install takeover@cc-market`. `.claude-plugin/marketplace.json` has no takeover entry. Both install commands fail outright. The install block also omits `evolve@cc-market`, which IS in the marketplace and the table above it.

---

### [SR-20260729-071] [HIGH] fabric/README.md — README's MCP tool list omits six shipped tools — `fan_out`, `team_spawn`, `team_send`, `team_status`, `team_synthesize`, `team_close` — and `fan_out` directly contradicts the stated first principle.

- **Category:** Feature
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Document the team/* session-fleet tools and `fan_out` in both fabric/README.md § MCP tools and fabric/AGENTS.md's tool table, and either retract or qualify the "fan-out is never a tool's job" principle now that `fan_out` is a tool.

`fabric/scripts/mcp-server.mjs` registers 13+ tools (lines 62–235): call, spawn_session, session_send, session_close, list_sessions, team_spawn, team_send, team_status, team_synthesize, team_close, list_providers, resolve_model, codex_status, fan_out. README § MCP tools lists 8; fabric/AGENTS.md's table lists the same 8. fabric/AGENTS.md's First principle states "fan-out is the orchestrator's job … never a tool's. So there is one call surface, not a 'single' tool and a 'batch' tool." A `fan_out` tool now exists — the doc's central design claim is false.

---

### [SR-20260729-072] [HIGH] fabric/README.md — Install section tells users to hand-register the MCP server in `~/.claude/settings.json`, but the plugin ships `fabric/.mcp.json` and auto-registers it.

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Delete the manual `mcpServers` JSON block; state that `/plugin install fabric@cc-market` registers the server automatically via the bundled `.mcp.json`.

`fabric/.mcp.json` declares `mcpServers.fabric` with `${CLAUDE_PLUGIN_ROOT}/scripts/mcp-server.mjs`. README lines 12–24 still say to register in `~/.claude/settings.json` with a hardcoded `<plugin-root>` path. Following it yields two fabric server instances with divergent in-process session registries, plus an absolute path that breaks on plugin update.

---

### [SR-20260729-073] [MEDIUM] rem/README.md — Install section tells users to hand-register four hooks in `~/.claude/settings.json`, duplicating `rem/hooks/hooks.json` which the plugin already registers.

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Replace the 45-line JSON block with a one-line statement that the plugin registers SessionStart/UserPromptSubmit/Stop hooks automatically; keep only the Codex note.

`rem/hooks/hooks.json` declares all four hooks with the exact commands the README reproduces. Following the README double-registers everything: `prune-memory.js --evict-stale` runs twice per SessionStart (two writers racing on `.claude/.rem-state.json` and MEMORY.md), `recall.js` injects duplicate additionalContext, and the Stop hook double-advances the stop counter — halving the effective ≥3-stop threshold gating `/rem`.

---

### [SR-20260729-074] [MEDIUM] sharp-review/README.md — Install instructions are inconsistent with every other plugin and reference a `scripts/setup/setup.js` that does not exist in this repo.

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Use `/plugin install sharp-review@cc-market` like the other plugin READMEs; drop the `claude_settings.json` hand-edit and the `node scripts/setup/setup.js` step.

sharp-review/README.md:7–20 says to hand-edit `claude_settings.json` and run `node scripts/setup/setup.js`. There is no `scripts/setup/` under cc-market — that setup.js lives in the parent config-sync repo, which a marketplace user does not have. All other plugin READMEs use `/plugin install <name>@cc-market`.

---

### [SR-20260729-075] [MEDIUM] README.md — Plugin table claims sharp-review runs "3 parallel reviewers"; the code and the plugin's own docs say 2 of N.

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Change to "2 of N parallel reviewers (dynamic provider roster)" to match cc-market/AGENTS.md and sharp-review/README.md.

README.md:26 says "3 parallel reviewers". cc-market/AGENTS.md and sharp-review/README.md both say 2 of N (dynamic roster). Commit 0e0e95b changed this and the root README was not updated despite its own keep-in-sync comment.

---

### [SR-20260729-076] [MEDIUM] rem/skills/rem/reference/scripts.md — The "REM Scripts Reference" table is presented as complete but omits three of the fifteen scripts, including both hook entry points.

- **Category:** Feature
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Add rows for `recall.js`, `inject-rules.js`, and `doc-freshness.js` (with its flags), and add the undocumented `--rescan` (crystallize.js) and `--fix`/`--quiet` (prune-memory.js) flags.

Missing: `recall.js` (UserPromptSubmit auto-recall hook), `inject-rules.js` (Codex SessionStart rules injector), `doc-freshness.js` (git-drift engine behind `/refresh-docs`). Matters because at runtime the `/rem` skill sees only SKILL.md and reference/*.md — an agent consulting this table cannot learn these scripts exist. Flag coverage is also stale: `--rescan`, `--fix`, `--quiet` (what hooks.json actually passes) are unlisted.

---

### [SR-20260729-077] [MEDIUM] fabric/AGENTS.md — The File Structure block documents an `engine/tests/` directory that does not exist.

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Delete the `engine/tests/` line; all suites live in `fabric/tests/`. Also add `lock.mjs` to the shared/ contents list.

`ls fabric/engine` shows no tests/ directory; every suite is in `fabric/tests/`, matching the AGENTS.md § Testing command — the doc contradicts itself. The same block lists shared/ as "spawn/lib/state/stamp/attention" but it also contains lock.mjs.

---

### [SR-20260729-078] [LOW] rem/skills/rem/reference/memory-conventions.md — The promotion counter is named `access_count` in prose, `count` in the format section, and `accessCount` in the JSON the code emits — three names for one field.

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Standardize on `count` (the on-disk `_meta.json` key), and note the `accessCount` alias where crystallize --propose JSON is described.

The actual `_meta.json` key is `count` (`rem/scripts/lib.mjs:233,263,268`; `rem-prep.js:166,188` gates on `meta.count >= 3`). `access_count` appears nowhere in code. `crystallize.js:103` emits `accessCount` in --propose but `count` in --drift (line 65). An agent following crystallize.md and reading `entry.access_count` gets undefined and silently classifies every entry as below the >= 5 rule-worthy threshold.

---

### [SR-20260729-079] [LOW] sharp-review/AGENTS.md — Test-file listing is missing three of the ten suites on disk.

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Add `pick-profile.test.mjs`, `profiles.test.mjs`, and `sources.test.mjs` to the tree under `tests/`.

AGENTS.md enumerates 7 suites; disk has 10. The three missing cover exactly the newest subsystem (source-adapter registry and weighted profile selection) the same AGENTS.md describes at length. Recurrence of the class flagged in SR-20260625-013 for rem/AGENTS.md.

---

### [SR-20260729-080] [LOW] fabric/README.md — § Layers describes `engine/codex/` as "codex app-server client + task runner", omitting the session and discovery modules the README's own persistent-session docs depend on.

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Update to "codex app-server client, task runner, session, discovery".

`fabric/engine/codex/` contains app-server.mjs, task.mjs, session.mjs, discovery.mjs. The README's L1 bullet names only the first two, yet its § MCP tools documents `spawn_session` (codex/session.mjs) and `codex_status` (codex/discovery.mjs). fabric/AGENTS.md gets this right, so the two docs disagree.

---

### [SR-20260729-081] [INFO] fabric/shared/codex 2 — A stray empty directory named `codex 2` (an OneDrive duplicate artifact) sits in fabric's bundled shared/ tree.

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Delete the empty `codex 2` directory; consider having the bundle-integrity test flag unexpected entries in */shared/.

Empty directory, documented nowhere, classic OneDrive conflict-copy suffix. All six bundled shared/*.mjs copies are otherwise byte-identical to cc-market/shared/ across every plugin — no bundle drift.
