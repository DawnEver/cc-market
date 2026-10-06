---
description: Write the supervision config for this project — one TOML file, no daemon spawned from here.
argument-hint: "[--template http|process|deploy|full]"
---

# /watch:setup

Scaffold `deploy/supervise.toml` for this project. **This command does not start anything.** The
daemon is a systemd unit and the schedule is a timer; both are installed on the host that runs the
target, and a Claude session is the wrong place to start either.

## Where the file goes, and why not `config/`

Write it to `deploy/supervise.toml`, beside the units that read it.

**Do not put it under `config/`.** That directory is gitignored in this family — it holds the
user-writable `config.toml` a checkout reads when run from its own root — so a config placed there
is never versioned at all. The whole point of the file is that what runs on a server is reviewable
in git; the `.gitignore` is rendered from the family base and hand-editing it reds a guard.

## What to write

1. **`[target]`** — a name. It keys the seat a cycle takes, so two targets on one host need two.
2. **`[process] manager`** — `systemd` for a host that has it.
3. **`[cycle] interval`** — how often a cycle runs. Below 5s the loop floors it: a supervisor that
   polls faster than the service can answer is competing with what it supervises.
4. **Components.** Each is a table under `[components.<name>]`; a shipped component is enabled
   unless its own table says `enabled = false`.
5. **`[remedies]`** — only where the default chain is wrong for this target.
6. **Secrets never.**

## Templates

**`http`** — watching a web service:

```toml
[components.http_health]
enabled = true

[[components.http_health.endpoints]]
name = "api"
url = "http://127.0.0.1:8000/health/"

[components.http_health.endpoints.expect]
status = "healthy"
```

**`process`** — watching a long-running job:

```toml
[components.process_monitor]
enabled = true

[[components.process_monitor.processes]]
name = "worker"
match = "my_worker"
min_count = 1
max_rss_mb = 400
```

**`deploy`** — deploying a release only after proving it in isolation:

```toml
[components.deploy]
enabled = true
unit = "my-service"
health = "http://127.0.0.1:8000/health/"
install = "make install-web"
run = "{python} -m my_app --home {home} --port {port}"
probe = ["http://127.0.0.1:{port}/health/"]
candidate_port = 8001

[components.deploy.repositories]
main = "/srv/my-service"
```

A deployment with no `install`, `run`, `probe`, `unit` or `health` is refused rather than run:
every phase would be skipped, every step would pass, and it would report deploying nothing at all.

## Secrets

Not in this file. They arrive through the environment — `systemd`'s `EnvironmentFile=` pointing at
a mode-600 file outside the repo — as `SUPERVISE_...` variables. **A double underscore separates the
levels**: `SUPERVISE_ALERTS__EMAIL__RECIPIENTS` sets `alerts.email.recipients`, while a single
underscore stays part of a key name, so `SUPERVISE_CYCLE__CHECK_TIMEOUT` addresses `check_timeout`
rather than inventing a `check.timeout` beside it.

## After writing it

```bash
python -m lab_commons.supervise check --project . --config deploy/supervise.toml
```

A first run against a target with no verified release reports `no_verified_release`. That is the
honest warning that the first deployment is the one with nowhere to roll back to, not a fault to
silence.
