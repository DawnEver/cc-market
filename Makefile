# The family's target headers (dev_lab.dev._famconfig_rows.MAKEFILE_BASE, a REQUIRED base: the names are the
# family's, every recipe is this repo's). This repo's tests are node:test files, so `verify` runs the node suite --
# the same command the forge's base part runs (pyproject [tool.lab_commons.tests]) -- and not the base's
# `python -m dev_lab.dev.verify`, which is ruff plus pytest and would check nothing here (declared drop in
# scripts/_famconfig.py).
.DEFAULT_GOAL := all

.PHONY: all clean fmt install install-dev lint test test-parallel verify

NODE_TESTS := fabric/tests/*.test.mjs rem/tests/*.test.mjs sharp-review/tests/*.test.mjs evolve/tests/*.test.mjs cc-latex/tests/*.test.mjs shared/tests/*.test.mjs tests/*.test.mjs

all: verify

clean:
	rm -rf output

# No formatter or linter is declared for this repo's JavaScript; the targets exist so the family contract holds.
fmt:

lint:

# No package.json: the only dependencies are the locked dev group.
install:
	uv sync --frozen

install-dev: install
	uv sync --frozen --all-groups
	uv run python -m dev_lab.dev.hook_install --install

test:
	node --test $(NODE_TESTS)

test-parallel:
	node --test --test-concurrency=4 $(NODE_TESTS)

verify:
	node --test --test-concurrency=4 $(NODE_TESTS)
