"""cc-market's delta against each family config base -- data, computed by nothing.

The bases live in ``dev_lab.dev._famconfig_rows``; ``python -m dev_lab.dev.famfiles --deltas
scripts/_famconfig.py`` turns base plus delta into the file.
"""

from __future__ import annotations

from typing import Final

from dev_lab.dev.famconfig import Delta

__all__ = ['DELTAS', 'REPO']

REPO: Final = 'cc-market'

# rem's derived memory index is rebuilt per checkout.
_GITIGNORE: Final = ('**/.claude/memory-index.md',)

# Every text file is LF in the tree and on checkout on every OS (rem parses memory line by line); binaries never
# normalize.
_GITATTRIBUTES: Final = (
    '* text=auto eol=lf',
    '*.png binary',
    '*.jpg binary',
    '*.jpeg binary',
    '*.gif binary',
    '*.ico binary',
    '*.woff binary',
    '*.woff2 binary',
)

# The Makefile is a REQUIRED base: its target headers are the family's, its recipes this repo's. Every line the
# base does not name -- the phony set, the default goal, the test list and the node recipes.
_MAKEFILE: Final = (
    '.DEFAULT_GOAL := all',
    '.PHONY: all clean fmt install install-dev lint test test-parallel verify',
    'NODE_TESTS := fabric/tests/*.test.mjs rem/tests/*.test.mjs sharp-review/tests/*.test.mjs evolve/tests/*.test.mjs cc-latex/tests/*.test.mjs shared/tests/*.test.mjs tests/*.test.mjs',
    '\trm -rf output',
    '\tuv sync --frozen',
    '\tuv sync --frozen --all-groups',
    '\tuv run python -m dev_lab.dev.hook_install --install',
    '\tnode --test $(NODE_TESTS)',
    '\tnode --test --test-concurrency=4 $(NODE_TESTS)',
)

#: The base's verify recipe is ruff plus pytest; this repo's tests are node:test, so `verify` runs the node suite --
#: the command the forge's base part runs -- instead.
_MAKEFILE_DROPPED: Final = {
    '\tpython -m dev_lab.dev.verify': 'the tests are node:test, so verify runs the node suite the base part runs',
}

DELTAS: Final[dict[str, Delta]] = {
    '.gitignore': Delta(repo=REPO, added=_GITIGNORE, dropped={}, ceiling=len(_GITIGNORE)),
    '.gitattributes': Delta(repo=REPO, added=_GITATTRIBUTES, dropped={}, ceiling=len(_GITATTRIBUTES)),
    '.rgignore': Delta(repo=REPO, added=(), dropped={}, ceiling=0),
    'Makefile': Delta(repo=REPO, added=_MAKEFILE, dropped=_MAKEFILE_DROPPED, ceiling=len(_MAKEFILE)),
}
