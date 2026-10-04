# watch — the Claude adapter over `lab_commons.supervise`

This plugin is a **front end**. The machinery it used to carry — config, state, the supervision
loop, remedy chains, alert transport, health probes, the deployment engine, the process manager —
now lives in `lab_commons.supervise`, a tier-2 subpackage of the family's shared library.

## The layering, and why it is this way

```
project            deploy/supervise.toml, systemd units        the target's own facts
cc-market/watch    commands/, skills/, plugin.json             THIS — Claude-only, zero logic
lab_commons        supervise/                                  the machine
lab_commons        log, paths, proc, liveness, resources       the foundation
```

**Only two of the four things this plugin used to do were ever Claude-specific.** The AI decision
tree and the session alert hook needed Claude. `watchd` said so itself in its own docstring — *"No
Claude Code dependency, survives session restarts"* — and the whole of `core/` was infrastructure
with no Claude and no domain in it. That machinery was trapped in a plugin distribution channel: a
server could only get it by unsupported means, its state/lock/log conventions diverged from the
family's, and it admitted three separate state stores with two spellings of the same counter.

## What is here now

| Path | What |
|---|---|
| `commands/{check,watch,setup}.md` | The three user-facing verbs |
| `skills/watch/SKILL.md` | The decision tree over the library's output |
| `.claude-plugin/plugin.json` | Plugin manifest |

**Nothing here computes.** Every command shells out to `python -m lab_commons.supervise`, which
means what a session sees and what a server does are the same code path. That was not true before:
the daemon and the AI loop each carried their own copy of the remedy chain.

## What was removed, and why

| Removed | Why |
|---|---|
| `core/` | Config, state, loop, remedies, alerting, logging, pidfile — all generic, all now in the library |
| `components/` | Health, resource, versioning and progress probes — now `lab_commons.supervise.components` |
| `scripts/` | Entry points and helpers superseded by `python -m lab_commons.supervise` |
| `hooks/` | The session-health alert hook. Confirmed for removal 2026-10-03 |
| `tests/` | They tested the code above |
| `requirements*.txt` | This plugin ships no Python |
| `migrations/` | It migrated adopter config between the old YAML shapes; the format is TOML now |
| `docs/`, `shared/` | Reference for internals that are gone, and the JS utilities its hooks used |

## Invariants

- **Config decides, not the command.** A rule restated in a `commands/*.md` is a second copy of it.
- **`config/` is gitignored in this family.** A target's supervision config goes in `deploy/`.
- **Nothing here starts a daemon.** Supervision runs under systemd on the target's host.
