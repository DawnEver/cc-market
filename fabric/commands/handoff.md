---
description: Hand off the current conversation to the next AI and save to .claude/memory/
allowed-tools: Bash
---

Your task: distill the current conversation into a **handoff** — a tight briefing that lets a
fresh AI pick up exactly where this one left off — then save it to a markdown file.

Center the handoff on **what's done, what's left, and what to do next**. The next AI has none
of this conversation's context, so give it what it needs to act, not a transcript.

## Content

- **Goal**: What are we ultimately trying to accomplish? (1 sentence)
- **Done so far**: What has actually been completed / decided / verified in this conversation.
- **Left to do**: Outstanding work — everything intended but not yet done (应做未做), ranked by
  priority, each specific (file paths, functions, concrete actions).
- **Next step**: The single most immediate thing the next AI should pick up first.
- **Current state**: Where exactly things stand right now — latest finding, blocker, or
  in-flight change (uncommitted edits, failing test, open branch).
- **Key decisions**: Non-obvious choices made and why — so the next AI doesn't relitigate them.
- **Open questions**: What's still unresolved or needs the user's input.

Keep it tight and actionable. The next AI needs to know what to do, not read a full history.

## Save

Write the handoff into the existing memory tree — reuse `.claude/memory/YYYY/MM/DD/`, don't
create a separate path. Ensure the dated dir exists first (idempotent):

```bash
mkdir -p .claude/memory/YYYY/MM/DD
```

Then write the handoff to `.claude/memory/YYYY/MM/DD/handoff-<topic>.md` —
filename = `handoff-` + a short kebab-case `<topic>` slug (e.g. `handoff-codex-support.md`).
Output the file path when done.
