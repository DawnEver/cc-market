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

DELTAS: Final[dict[str, Delta]] = {
    '.gitignore': Delta(repo=REPO, added=_GITIGNORE, dropped={}, ceiling=len(_GITIGNORE)),
    '.gitattributes': Delta(repo=REPO, added=_GITATTRIBUTES, dropped={}, ceiling=len(_GITATTRIBUTES)),
}
