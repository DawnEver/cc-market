"""Runtime patches applied before zotero-mcp-server starts.

Bug: pyzotero's ``Zotero.attachment_both`` copies the *full file path* into the
attachment template's ``filename`` field. The Zotero web API rejects stored-file
filenames containing a directory path::

    400: Stored-file filename '/Users/.../paper.pdf' cannot contain a directory path

So the attachment item is never created, the upload silently lands in the
``failure`` list — and zotero-mcp-server's ``zotero_add_from_file`` does not
inspect that list, reporting a false "File attached: ..." success.

Fix (applied here, before the server starts):

1. ``attachment_both`` keeps only the basename in ``filename`` and passes the
   real directory via ``Zupload``'s ``basedir`` parameter (its intended use).
2. A non-empty ``failure`` list raises, so callers surface the error instead
   of silently ignoring it.

See .claude/memory/2026/07/26/zotero-hybrid-mode-pdf-bug.md.
"""

from __future__ import annotations

import inspect
import sys
from pathlib import Path

# pyzotero internals this patch depends on. Developed against pyzotero 1.7.x
# (Zupload(basedir=...) exists since 1.6). If a pyzotero upgrade changes any
# of these, apply() raises loudly at server start instead of rotting silently.


def _guard(Zotero, Zupload) -> None:
    problems = []
    if not hasattr(Zotero, "_attachment_template"):
        problems.append("Zotero._attachment_template is gone")
    if "basedir" not in inspect.signature(Zupload.__init__).parameters:
        problems.append("Zupload.__init__ lost the basedir parameter")
    if not hasattr(Zupload, "upload"):
        problems.append("Zupload.upload is gone")
    if problems:
        raise RuntimeError(
            "zotero_mcp_patch: pyzotero internals changed — the attachment_both "
            "patch no longer applies: " + "; ".join(problems)
        )
    print("zotero_mcp_patch: pyzotero attachment_both patched "
          "(basename filename + basedir; raise on failure)", file=sys.stderr)


def apply() -> None:
    from pyzotero._client import Zotero
    from pyzotero._upload import Zupload

    _guard(Zotero, Zupload)

    def attachment_both(self, files, parentid=None):
        """Patched: basename-only filename + basedir, raise on failure."""
        orig = self._attachment_template("imported_file")
        by_dir: dict[str, list[dict]] = {}
        for title, fpath in files:
            p = Path(fpath)
            tmpl = orig.copy()
            tmpl["title"] = title
            tmpl["filename"] = p.name
            by_dir.setdefault(str(p.parent), []).append(tmpl)

        result: dict[str, list] = {"success": [], "failure": [], "unchanged": []}
        for basedir, templates in by_dir.items():
            res = Zupload(self, templates, parentid, basedir=basedir).upload()
            for key in result:
                result[key].extend(res[key])

        if result["failure"]:
            names = [t.get("filename", "?") for t in result["failure"]]
            raise RuntimeError(f"Zotero attachment upload failed for: {names}")
        return result

    Zotero.attachment_both = attachment_both
