"""Reading cards on disk.

Both synthesis and export need to load every card a workspace holds, which is
why this is its own module rather than a private helper on either of them.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from academia.litreview.models import PaperCard


def load_cards(topic_dir: Path, paper_ids: list[str] | None = None) -> list[PaperCard]:
    """Load PaperCards from reading/*.json as fully typed dataclasses."""
    from academia.litreview.models import PaperCard

    reading_dir = topic_dir / "reading"
    cards: list[PaperCard] = []
    if not reading_dir.exists():
        return cards
    for card_path in sorted(reading_dir.glob("*_card.json")):
        cid = card_path.stem.replace("_card", "")
        if paper_ids and cid not in paper_ids:
            continue
        cards.append(PaperCard.from_dict(json.loads(card_path.read_text(encoding="utf-8"))))
    return cards


_BIBTEX_SPECIALS = {"&": r"\&", "%": r"\%", "$": r"\$", "#": r"\#", "_": r"\_"}
