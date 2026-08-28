# Step 03 — PDF acquisition

Script-first batch PDF acquisition with multi-scenario access handling.
For detailed paywall methodology → see `03-acquire-paywall.md` (progressive disclosure).

## 来源优先级(publisher 站有 Cloudflare Turnstile,自动下载必失败)

解析 DOI(Unpaywall/OpenAlex/SS)后,按此优先级找 PDF:

1. **University repository** — `repo.uni-hannover.de`, `acris.aalto.fi`,
   `nottingham-repository.worktribe.com`, etc. 无 Cloudflare,HTTP 快路径。
2. **Preprint servers** — arXiv, techrxiv。直接 PDF。
3. **ResearchGate** — author-uploaded PDF,付费墙常可拿。由
   `literature_review/acquire/researchgate.py` 处理三跳(search → publication → /download)。
   **限速极严,升级到 IP ban**:~6s 间隔、每篇 ≤3 个 pub 页、home 页预热。Cloudflare
   **error 1020(IP 级 ban)不可解**——熔断跳过本轮,不要重试,等 ban 解除或换网络。
   绝不尝试规避,以免损害机构 IP 信誉。
4. **Publisher OA page** — 最后手段;需真实 Chrome + 持久 profile + cookie-dismissal + PDF 按钮自动点击。

**排查工具**:`uv run --project "${CLAUDE_PLUGIN_ROOT}" lit-review acquire --topic <slug> --dry-run` 打印每篇的源计划(不下载);
`download/download_log.csv` 记录每个 URL 的失败原因——先读那列再手动重试。

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
uv run --project "${CLAUDE_PLUGIN_ROOT}" lit-review login --profile <name> --url <publisher-page> --completion browser-close   # headed Chrome; log in, then close the window
uv run --project "${CLAUDE_PLUGIN_ROOT}" lit-review acquire --topic <slug> --approved-by <you> --profile <name> --limit <N>     # reuse the saved session
```

Without `--profile`, an OA mirror or repository usually suffices, but publisher
paywalls will silently fail (the browser has no auth cookies).

## Steps

1. **Build & review download queue**:
   ```bash
   uv run --project "${CLAUDE_PLUGIN_ROOT}" lit-review acquire --topic <slug> --queue-only
   ```

2. **Approve & download in ONE run** — auto-approves all `include` decisions
   (`maybe` items stay unapproved and are skipped; pass `--candidate-id <id>`
   to explicitly include one) and walks the full transport ladder:
   ```bash
   uv run --project "${CLAUDE_PLUGIN_ROOT}" lit-review acquire --topic <slug> --approved-by <you> --profile <name> --limit <N>
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
   - ⚠️ A profile lock on Windows makes `uv run --project "${CLAUDE_PLUGIN_ROOT}" lit-review login` force-kill every
     `chrome.exe` (`taskkill /F /IM chrome.exe`) to reopen it — close your
     personal Chrome windows first.

3. **Only if a paper still fails after the full ladder**, classify its access
   scenario and decide whether a human step is genuinely unavoidable:

   | Scenario | Detection | Method |
   |----------|-----------|--------|
   | **arXiv preprint** | `arxiv_id` in provider_raw | Direct HTTP download |
   | **Open Access** | OpenAlex `is_oa=true` | Download from `oa_url` |
   | **Campus IP** | `128.243.*` or `*.nottingham.ac.uk` | Direct HTTP for OA; publisher PDF endpoints still need a session → `--profile` |
   | **VPN** | User says VPN is on | Same as campus IP |
   | **Off-campus / paywall** | OA check fails + no campus IP | `uv run --project "${CLAUDE_PLUGIN_ROOT}" lit-review login --profile <name>` then `acquire --profile <name>` |
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
  │     └─ uv run --project "${CLAUDE_PLUGIN_ROOT}" lit-review login --profile <name> → acquire --profile <name>
  │
  └─ Fully closed? → skip, note in audit log
```
