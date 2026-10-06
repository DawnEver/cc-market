# watch

**The Claude front end over `lab_commons.supervise`.**

Unattended supervision of a server or a long-running task: health checks, anomaly detection,
auto-repair and multi-channel alerting, configured in one TOML file per project. The machinery is
in the family's shared library; what is here is the part that needs Claude.

## Why this is a front end now

It used to carry everything. Four things ran: a Python daemon, a session-independent poller, the
Claude decision tree, and a session alert hook. **Only the last two needed Claude.** The daemon said
so in its own docstring — *"No Claude Code dependency, survives session restarts"* — and the whole
of `core/` was generic infrastructure with no Claude and no domain in it: config, state, the
supervision loop, remedy chains, alert transport, logging, a pidfile.

Keeping that in a plugin meant a server could only get it by unsupported means, and it drifted where
nobody could see: **two copies of the remedy chain**, one in the daemon and one in the AI loop, so
the same anomaly could be remedied two ways depending on who noticed. It also kept three separate
state stores, two of which spelled the same counter differently.

The machine now lives in `lab_commons.supervise`, a tier-2 subpackage any repo in the family
installs by depending on `lab-commons`. A server gets it the ordinary way.

```
project            deploy/supervise.toml + systemd units     the target's own facts
cc-market/watch    commands/ + skills/ + plugin.json         THIS — Claude-only, zero logic
lab_commons        supervise/                                the machine
```

## The three verbs

| Command | What it does |
|---|---|
| `/watch:setup` | Writes this project's `deploy/supervise.toml`. Starts nothing. |
| `/watch:check` | Runs the checks once and reports. No scheduling, no repair. |
| `/watch:watch` | Reads the state and decides what a person should hear about. |

All three shell out to the same code path a server runs:

```bash
python -m lab_commons.supervise check   --project . --config deploy/supervise.toml
python -m lab_commons.supervise serve   --project . --config deploy/supervise.toml
python -m lab_commons.supervise digest  --project .
```

## What it deliberately does not do

**It does not start a daemon.** Supervision runs under systemd on the host that runs the target — a
unit with a `MemoryMax`, restarted by the manager that owns it. A Claude session adds judgment when
a person is watching; it is not a supervisor, and a deployment must never be started from one.

**It does not keep its own lock.** The library takes a seat from `lab_commons.resources.Broker`,
which is the family's one mechanism for it. A pid file or a heartbeat here would be a second
definition of the same thing — the library says so in as many words.

## Where the config goes

`deploy/supervise.toml`, beside the units that read it.

Not `config/` — that directory is gitignored in this family (it holds the user-writable
`config.toml` a checkout reads from its own root), so a config placed there is never versioned, and
being versioned is the whole point. The `.gitignore` is rendered from the family base and
hand-editing it reds a guard.

## Adopting it in a project

1. `/watch:setup` — write the config.
2. Install the units on the host that runs the target, so supervision survives a session.
3. **Prove the deployment gate works before trusting it.** A release is built in its own worktree,
   started on a spare port against the real data, and asked the questions in `probe` before the
   live service is touched. A deployment with no `install`, `run`, `probe`, `unit` or `health` is
   refused rather than run — otherwise every phase is skipped, every step passes, and it reports
   deploying nothing at all.

## Reference

- `AGENTS.md` — the layering, and what was removed and why
- `skills/watch/SKILL.md` — the decision tree over the library's output
- `lab_commons.supervise` — the machine, documented where it lives
