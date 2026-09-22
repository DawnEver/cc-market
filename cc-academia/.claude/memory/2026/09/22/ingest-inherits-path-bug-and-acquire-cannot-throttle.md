---
name: ingest-inherits-path-bug-and-acquire-cannot-throttle
description: Two unfixed defects surfaced by a real run — ingest is unusable on a data path containing a space, and acquire exposes no frequency control
metadata:
  type: engineering
---

# Two defects a real run surfaced, neither yet fixed

Neither of these is a regression. Both were found by using the plugin on a real
data tree, and both are recorded rather than patched so the next run does not
have to rediscover them.

## 1. `lit-review ingest` cannot run when the data path contains a space

`paper_pdf_ingest` hands each PDF to `pymupdf4llm.to_markdown(..., image_path=)`,
and that library derives extracted-image names from the source filename after
replacing spaces with underscores. The file is written under one name and
reopened under another, so **every paper fails** with

```
code=2: cannot open file '.../Some_Directory_With_Spaces/...'
```

on a data tree whose path has a space anywhere in it. A OneDrive-style directory
name is enough.

Nothing in the plugin guards this. The failure is per-paper, identical for every
paper, and the message names a path that never existed — so the first guess is
usually "the files are missing" rather than "the path is being rewritten".

Neither of the two obvious escapes works, and both are worth knowing:

- **Pointing `ACADEMIA_DATA_ROOT` at a space-free symlink does not help.** The
  path is resolved before use, and a symlink resolves to its space-bearing
  target.
- **`lit-review repair` does not help.** It re-derives each stored path from the
  filesystem, and the filesystem reports the real location.

A caller who needs the text can extract it directly (PyMuPDF over each PDF),
which is sufficient when the downstream task is a method-level reading rather
than one needing figures or per-section splits.

**What a fix would look like:** detect a space in the resolved PDF path before
invoking the decomposer and fail with a message that names the cause, or copy
the PDF to a space-free staging path first. The second is better — it makes the
step work rather than reporting that it cannot.

## 2. `acquire` exposes no frequency control

The subparser has no delay, throttle or rate parameter. An operator whose batch
download triggers the publisher's anti-automation challenge has **no way to slow
down** through the tool, only by hand-running it in small batches with pauses
between.

For a command whose normal operation can provoke a counterparty's bot defence,
this is the one knob most likely to be needed and the one missing. It should
exist with a conservative default rather than as an opt-in flag: the operator
who needs it is, by definition, the one who did not anticipate needing it. A
second challenge is the warning that precedes an IP-level ban, and a tool that
cannot be told to go slower offers the operator no way to heed it.

## Also noted, minor

- The `login` and `acquire` subparsers disagree on their `--browser-channel`
  default (`chromium` vs `chrome`), and the `login` default points at a build
  that may not be installed — it then prints the Playwright install banner and
  exits 0, having done nothing. Covered in the data repo's memory; repeated here
  because it is a plugin-side default.
- A scoring lens living outside the working directory was looked for inside it.
  Not a plugin defect, but the plugin's playbooks could state resolved paths.
