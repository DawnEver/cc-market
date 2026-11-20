---
name: action-start-dir-env
description: New managed-action field start_dir_env — env-var-named absolute cwd overriding static start_dir, so dynamic staging paths need no inline python. v1.0.40.
metadata:
  type: project
---

watch **v1.0.40**. Continues [[action-forms-and-core-dedup]] (the managed kill_port/start_cmd/steps form).

### Motivation
The managed form's `start_dir` is a static path relative to project-dir, and **cannot express a cwd known only at runtime**
(the deploy gate exports a dynamic staging path to env). The consumer (<project>) was therefore forced to keep, for the test-instance action,
an inline `python -c "...glob(start-server.py)...Popen(...)"`, which is hard to test and leaks console windows on Windows.

### Changes
- `components/base.py`: `Action` gains `start_dir_env: str | None`.
- `core/actions.py`: `_exec_managed` resolves cwd — if `start_dir_env` hits an env var then
  `Path(os.environ[var]).resolve()` takes precedence; else fall back to `start_dir` (relative to project-dir); else project-dir.
  Adds `import os`. **Backward compatible**: behaviour unchanged when the field is unset.
- `tests/test_actions.py`: two cases (override / fallback), asserting the `--project-dir` start-server.py receives.
  Full suite 162 passed.
- README Actions section + plugin.json 1.0.39→1.0.40.

### Note
Older plugins do not recognise the new field (registry silently drops it by `__dataclass_fields__`) → consumer config must upgrade to
1.0.40 before enabling `start_dir_env`, else cwd silently falls back.

> Amended 2026-11-17: translated to English (D26) -- approved: "(user, translated) .claude/memory/ and .claude/tasks/ should also be English only"
