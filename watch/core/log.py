"""JSONL structured logging."""

from __future__ import annotations

import json
from pathlib import Path


def append_report(report: dict, project_dir: Path,
                  log_file: str = '.claude/watch/logs/health.jsonl',
                  max_entries: int = 10000) -> None:
    path = project_dir / log_file
    path.parent.mkdir(parents=True, exist_ok=True)
    line = json.dumps(report, ensure_ascii=False)

    if not path.exists():
        path.write_text(line + '\n', encoding='utf-8')
        return

    lines = path.read_text(encoding='utf-8').splitlines()
    if len(lines) >= max_entries:
        lines = lines[-(max_entries - 1):]
    lines.append(line)
    path.write_text('\n'.join(lines) + '\n', encoding='utf-8')
