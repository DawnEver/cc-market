# Step 03 — PDF acquisition

Script-first batch PDF acquisition with multi-scenario access handling.
For detailed paywall methodology → see `03-acquire-paywall.md` (progressive disclosure).

## Source priority (publisher sites sit behind Cloudflare Turnstile, so automated download always fails)

After resolving the DOI (Unpaywall/OpenAlex/SS), look for the PDF in this priority order:

1. **University repository** — `repo.uni-hannover.de`, `acris.aalto.fi`,
   `<institution>-repository.worktribe.com`, etc. No Cloudflare; the fast HTTP path.
2. **Preprint servers** — arXiv, techrxiv. Direct PDF.
3. **ResearchGate** — author-uploaded PDF, often available past a paywall. Handled by
   `literature_review/acquire/researchgate.py` in three hops (search → publication → /download).
   **Very strict rate limit that escalates to an IP ban**: ~6 s spacing, ≤3 pub pages per paper, warm up on the home page. Cloudflare
   **error 1020 (IP-level ban) cannot be worked around** -- trip the breaker and skip this round; do not retry; wait for the ban to lift or switch networks.
   Never try to evade it, so as not to damage the institution's IP reputation.
4. **Publisher OA page** — the last resort; needs a real Chrome + persistent profile + cookie dismissal + an automatic click on the PDF button.

**Troubleshooting**: `uv run --project "<plugin-root>" lit-review acquire --topic <slug> --dry-run` prints each paper's source plan (no download);
`download/download_log.csv` records the failure reason for each URL -- read that column first, then retry by hand.

## Core principle

**Agent auto-clicks. User only intervenes when manual login is unavoidable.**

**Do not hand-restrict the transport ladder.** `--http-only` is for diagnosis
(dry-run / log inspection) or headless/CI machines with no display only —
never for a normal run. The default acquire call already walks the full ladder
`http → browser → researchgate` internally, cheapest-capable first. Just run it.

**Session reuse requires a saved profile.** A bare `--browser-channel chrome`
launches a fresh temporary context with **zero cookies** — it does NOT attach
your real Chrome sessions. To download subscribed/off-campus papers you MUST
first create a profile and pass it to acquire:

```bash
uv run --project "<plugin-root>" lit-review login --profile <name> --url <publisher-page> --completion browser-close   # headed Chrome; log in, then close the window
uv run --project "<plugin-root>" lit-review acquire --topic <slug> --approved-by <you> --profile <name> --limit <N>     # reuse the saved session
```

Without `--profile`, an OA mirror or repository usually suffices, but publisher
paywalls will silently fail (the browser has no auth cookies).

## Steps

1. **Build & review download queue**:
   ```bash
   uv run --project "<plugin-root>" lit-review acquire --topic <slug> --queue-only
   ```

2. **Approve & download in ONE run** — auto-approves all `include` decisions
   (`maybe` items stay unapproved and are skipped; pass `--candidate-id <id>`
   to explicitly include one) and walks the full transport ladder:
   ```bash
   uv run --project "<plugin-root>" lit-review acquire --topic <slug> --approved-by <you> --profile <name> --limit <N>
   ```
   - `--limit` is capped at 20 (hard bound in the engine); a value above 20
     aborts the run with an error.
   - `--browser-channel` defaults to `chrome`; omit it.
   - There is **no `--headed` flag** — the browser transport is always headed.
   - HTTP wins where an OA mirror exists; browser transport takes over for
     Cloudflare-guarded / subscribed hosts; ResearchGate is tried last with its
     built-in circuit breaker (error 1020 → skip, never retry).
   - Run asynchronously using the current host's mechanism: Claude Code may use
     Bash `run_in_background`; Codex starts the shell command, retains its cell id,
     and waits/polls that cell. If neither mechanism is available, run in the
     foreground. Continue other work only while the process is genuinely retained;
     never start an untracked detached process. Check `download/download_log.csv` afterwards for
     per-URL failure reasons — read that column before any manual retry.
   - ⚠️ A headed browser needs the display; on a headless/CI box without one,
     use `--http-only` (publisher URLs will be logged as failed for manual
     retrieval) or run on a machine with a display.
   - ⚠️ A profile lock on Windows makes `uv run --project "<plugin-root>" lit-review login` force-kill every
     `chrome.exe` (`taskkill /F /IM chrome.exe`) to reopen it — close your
     personal Chrome windows first.

3. **Only if a paper still fails after the full ladder**, classify its access
   scenario and decide whether a human step is genuinely unavoidable:

   | Scenario | Detection | Method |
   |----------|-----------|--------|
   | **arXiv preprint** | `arxiv_id` in provider_raw | Direct HTTP download |
   | **Open Access** | OpenAlex `is_oa=true` | Download from `oa_url` |
   | **Campus IP** | institution IP range or `*.<institution-domain>` | Direct HTTP for OA; publisher PDF endpoints still need a session → `--profile` |
   | **VPN** | User says VPN is on | Same as campus IP |
   | **Off-campus / paywall** | OA check fails + no campus IP | `uv run --project "<plugin-root>" lit-review login --profile <name>` then `acquire --profile <name>` |
   | **CAPTCHA wall** | Page body has "captcha" / "verify you are human" | Real Chrome via a saved `--profile` session |

4. **Manual fallback only when auto-click is impossible**: the script opens the
   paper URL in visible Chrome; user clicks "View PDF" once; file auto-saves.

5. **Match & manifest**: script matches downloaded PDFs to queue entries.

6. **Report**: X downloaded, Y failed, Z matched. Proceed to step 04.

## Manual fallback

If auto-click fails, the script opens the paper URL in visible Chrome.
User clicks "View PDF" once; the file is auto-saved to the download directory.

## Paywall decision tree

```
Paper to acquire
  │
  ├─ arXiv preprint? → direct HTTP download (free, fast, legal)
  │
  ├─ Open Access? (OpenAlex API) → download from oa_url
  │
  ├─ Author preprint? → search arXiv by author + title keywords
  │
  ├─ Campus IP / VPN? → run acquire with --profile (publisher PDF needs a session)
  │
  ├─ Off-campus with institutional access?
  │     └─ uv run --project "<plugin-root>" lit-review login --profile <name> → acquire --profile <name>
  │
  └─ Fully closed? → skip, note in audit log
```
