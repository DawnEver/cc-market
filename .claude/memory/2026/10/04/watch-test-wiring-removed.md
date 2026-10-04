---
name: watch-test-wiring-removed
description: watch has no Python tests after the lab_commons.supervise refactor; hook/release/CI no longer run them
---
# watch Python test wiring removed

The watch refactor (45b3266) deleted `watch/tests` but left the pre-commit hook, `release.sh` and
CI running `python -m unittest discover watch/tests/`. An empty discovery exits non-zero, so every
watch commit failed. 0218d36 removed that wiring; watch changes now trigger only the bundle and
gen-codex checks. Released as v2.5.68 (pre-push requires a tagged release for plugin changes).
