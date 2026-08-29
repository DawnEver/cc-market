# Running the cc-academia CLI

Read this once; every playbook references it rather than repeating it.

## Resolve the plugin root

The loaded workflow lives at `<plugin-root>/skills/<skill>/SKILL.md`; derive
`<plugin-root>` from that path and substitute its absolute value below. This is
skill-relative resource resolution, not configuration. Do not read or create a
plugin-root environment variable. Quote the path because installations may
contain spaces.

## The invocation

```bash
uv run --project "<plugin-root>" lit-review <command> [flags]
uv run --project "<plugin-root>" rev-disc  <command> [flags]
uv run --project "<plugin-root>" academia  <command> [flags]
```

Why `--project` rather than a bare `lit-review`: the playbook and the code it
calls are in the same tree and therefore the same version. Nothing has to be
installed, checked or pinned. This is the reason there is no lock file or
version check anywhere in this plugin.

## First run

`uv` resolves and caches the environment on first use (a few seconds), then it
is instant. If the environment ends up on a synced folder, set
`UV_PROJECT_ENVIRONMENT` to a local path first — see `AGENTS.md`.

## Checking the installation

```bash
uv run --project "<plugin-root>" academia doctor
```

Reports the active plugin root, which config directory is in effect, whether a
user override is shadowing the defaults, where the database lives, and which
optional extras are installed. Run it first when something behaves unexpectedly.

## Machine-readable output

Every command accepts `--json`, which writes a structured payload to **stdout**
while human progress goes to **stderr**. Parse the JSON; do not scrape the log.

Exit codes are part of the contract:

| Code | Meaning |
|------|---------|
| 0 | success |
| 2 | usage error — bad arguments, missing workspace, unknown journal |
| 3 | external source failure — API down, rate limited, blocked |

A `3` is worth retrying later; a `2` never is.

## Optional extras

Some commands need dependencies that are not installed by default:

| Extra | Needed for |
|-------|-----------|
| `acquire` | HTTP PDF download |
| `browser` | publisher sites that require a real browser |
| `pdf` | PDF decomposition and manuscript ingest |
| `plot` | `lit-review stats --plots` |
| `zotero` | the Zotero bridge |
| `ai` | deep-read and synthesis through litellm |

Install with `uv sync --project "<plugin-root>" --extra <name>`. If a
command needs one, it says so by name rather than failing obscurely.
