# Ingest failure triage

| Error message | Diagnosis | Action |
|---------------|-----------|--------|
| `marker_single: command not found` | `marker-pdf` not installed in the venv | Ingest falls back to `pymupdf4llm` automatically. No user action needed — the summary will note "ingested via pymupdf4llm (marker-pdf unavailable)". |
| `No module named 'pymupdf4llm'` | venv is missing dependencies | Re-create venv: `rm -rf ~/.local/share/manuscript-review-venv && python3 -m venv ~/.local/share/manuscript-review-venv && ~/.local/share/manuscript-review-venv/bin/pip install pymupdf4llm` |
| `No module named 'torch'` or CUDA/Metal errors | GPU detection failed, but ingest should still work | The script falls back to `pymupdf4llm`. If that also fails, run `~/.local/share/manuscript-review-venv/bin/pip install pymupdf4llm` manually. |
| `PDF appears to be scanned (no extractable text)` | The PDF is image-only — OCR needed | Tell the user: "This PDF has no selectable text. Please run OCR (e.g. Adobe Acrobat, ocrmypdf) and re-submit." |
| `Permission denied` on output path | File locked by sync service (e.g. OneDrive) | Wait a few seconds and retry. If persistent, move the PDF outside the OneDrive folder and re-run. |
| Empty `md/` directory after ingest | PDF text extraction produced nothing usable | Check `0-raw.pdf` opens correctly. If the PDF is password-protected or corrupted, ask the user to provide an unprotected copy. |
| Multi-paper detection false positive (appended/ has content from main paper) | Boundary detection split mid-paper | Delete `ongoing/<slug>/1-paper-text/` and re-ingest with `--reingest`. The user may need to manually split if the PDF has unusual formatting. |
