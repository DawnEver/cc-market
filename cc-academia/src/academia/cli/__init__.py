"""CLI entry points.

Five console scripts share one dispatcher:

* ``academia``   — cross-cutting maintenance (doctor, db, repair, release checks)
* ``academia-read`` — the systematic literature review pipeline
* ``academia-review``  — manuscript review ingest and status
* ``academia-write``   — manuscript writing checks over the knowledge base
* ``academia-referee``   — reviewer discovery
"""

from __future__ import annotations

from academia.cli.dispatch import (
    main,
    read_main,
    referee_main,
    review_main,
    write_main,
)

__all__ = ["main", "read_main", "referee_main", "review_main", "write_main"]
