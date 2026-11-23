"""Test stub: emits the pinned texcount fixture regardless of arguments."""

import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from texcount_fixture import FIXTURE

sys.stdout.write(FIXTURE)
