---
description: Summarize the current conversation and save to .claude/summary/
allowed-tools: Bash
---

Your task: synthesize the current conversation into a structured, action-oriented summary, then save it to a markdown file.

## Content

Structure the summary around **what to do next** — the primary purpose is to guide the next session:

- **Next steps**: What should happen next? (ranked by priority, be specific — file paths, actions)
- **Current state**: Where exactly are we right now? Latest finding or blocker?
- **Goal**: What are we trying to accomplish? (1 sentence)
- **Key decisions**: Non-obvious choices made and why.
- **Unresolved questions**: What's still open?

Keep it tight and actionable. The reader needs to know what to do, not a full transcript.

## Save

After writing the summary, save it:

```bash
mkdir -p .claude/summary
```

Then write the summary to `.claude/summary/YYYY-MM-DD-HHmm.md` (use the current date/time). Output the file path when done.
