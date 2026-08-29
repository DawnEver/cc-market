# Step 02 — Unified search & AI screening

AI 生成查询 → CLI 执行检索 → AI 批量筛选摘要。

## Steps

1. **Read the brief**. Extract concepts with `selected: true` and `role` in `[must, should, context]`.

2. **Generate Boolean queries** from concept taxonomy. Optionally review them with the canonical prompt in
   `.claude/agents/query-reviewer.md`:
   - **Claude Code:** invoke the `literature-query-reviewer` named agent.
   - **Codex:** read that prompt, then spawn a collaboration subagent with the brief and proposed queries. If collaboration tools are unavailable, run the same prompt in the current model; do not silently skip review.
   - Treat the prompt file as the single source of truth. Require one result for every `query_id`, reject duplicate/unknown IDs, and require `verdict`, `issues`, `suggested_fix`, and `rationale` before applying suggestions. The user still approves queries before they are written.

3. **Present queries** to user. Write to `workspaces/<slug>/queries.toml`.

4. **Probe** (optional but recommended):
   ```bash
   uv run --project "<plugin-root>" lit-review search --topic <slug> --probe-only
   ```
   Shows estimated hit counts. Adjust queries if needed, then re-run.

5. **Full search** — one command handles probe → search → normalize → dedupe → screening packet:
   ```bash
   uv run --project "<plugin-root>" lit-review search --topic <slug>
   ```

6. **AI screens all abstracts** in batches using the canonical prompt in
   `.claude/agents/abstract-screener.md`:
   - Use the screening packets emitted by the CLI; never invent or drop candidates. Process independent packets in parallel when the host supports it.
   - **Claude Code:** invoke one `literature-abstract-screener` named agent per packet.
   - **Codex:** read the canonical prompt and spawn one collaboration subagent per packet, subject to the available concurrency limit. If collaboration tools are unavailable, process packets sequentially in the current model with the same prompt.
   - Save each response as JSONL. Validate through `uv run --project "<plugin-root>" lit-review import-screening`, whose canonical validator checks JSONL shape, field values, duplicate/unknown IDs, and exact candidate coverage before writing merged output. Retry an invalid packet once with the reported validation errors; if it remains invalid, stop and report it rather than partially importing results.

7. **Import screening results**:
   ```bash
   uv run --project "<plugin-root>" lit-review import-screening --topic <slug> --batch <batch_001.jsonl> --batch <batch_002.jsonl> ...
   ```

8. **Report stats**: total, included, maybe, excluded. Show top candidates. Proceed to step 03.
