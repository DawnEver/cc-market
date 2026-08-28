# 01 — Intake and profile

Turn the submission into something searchable, without letting its body text
travel anywhere.

## Create the workspace

With a PDF:

```bash
uv run --project "${CLAUDE_PLUGIN_ROOT}" rev-disc init /path/to/manuscript.pdf \
  --slug <slug> --journal <tie|tii|tte|...>
```

Without one — metadata pasted from the editorial system. Often the better path,
since it avoids putting the PDF on disk at all:

```bash
uv run --project "${CLAUDE_PLUGIN_ROOT}" rev-disc init \
  --slug <slug> --journal tie --year 2026 \
  --title "..." --abstract "..." --keywords "kw1,kw2,kw3"
```

`init` is the only command that reads the PDF. It writes
`1-manuscript/sanitized.json`, and nothing beyond that file is available to
anything downstream.

**Check the extraction before continuing.** PDF layouts vary; a title lifted from
the running head, or an abstract that swallowed the introduction, quietly
degrades every later step. Read `sanitized.json` and confirm it with the user.

## Declare the submitting authors

Conflict screening cannot work without them. If `init` did not capture them, add
them to `sanitized.json`:

```json
"authors": [
  {"name": "Alice Author", "affiliation": "Tsinghua University", "country": "CN"},
  {"name": "Bob Second",  "affiliation": "Tsinghua University", "country": "CN"}
]
```

Author names and affiliations are used **only** for exclusion. They never
influence who is recommended.

Country matters: it sets the submission's origin for geographic separation. Give
the country of the *institution*, not anyone's nationality.

## Build the profile

```bash
uv run --project "${CLAUDE_PLUGIN_ROOT}" rev-disc profile --slug <slug> --json
```

Produces topics, methods and a set of boolean queries deterministically, so the
pipeline runs with no model and no API key configured.

## Review the queries with the user

This is the highest-leverage moment in the workflow. Bad queries mean the right
reviewers never enter the candidate pool, and nothing downstream can recover
them.

Show the topics and the queries, and ask specifically:

- Does the first query capture what the paper is *about*, or only what its title
  says?
- Is there a term of art the abstract avoids but the field uses?
- Is any query so broad it will return the entire subfield?

Edit `1-manuscript/paper_profile.json` directly, or re-run `profile` after
supplying better `--keywords` at `init`.

When the queries look right, continue to `02-search.md`.
