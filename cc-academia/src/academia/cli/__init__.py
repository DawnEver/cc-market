"""CLI entry points.

Three console scripts share one dispatcher:

* ``academia``   — cross-cutting maintenance (doctor, db, repair, release checks)
* ``lit-review`` — the systematic literature review pipeline
* ``rev-disc``   — reviewer discovery
"""

from __future__ import annotations

from academia.cli.dispatch import lit_review_main, main, rev_disc_main

__all__ = ["lit_review_main", "main", "rev_disc_main"]
