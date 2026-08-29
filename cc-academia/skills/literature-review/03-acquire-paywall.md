# Paywall PDF Acquisition — Reference

Progressive disclosure: loaded when the agent encounters a paper that fails OA + arXiv checks.

## Decision Tree

```
Paper needs PDF
  │
  ├─ 1. arXiv preprint search
  │     ├─ provider_raw.arxiv_id → https://arxiv.org/pdf/{id}.pdf
  │     ├─ Title search: http://export.arxiv.org/api/query?search_query=all:{title}
  │     └─ Author search: http://export.arxiv.org/api/query?search_query=au:{surname}+AND+all:{topic}
  │     ✅ 5/7 papers in CHP review found via arXiv
  │
  ├─ 2. Open Access check
  │     ├─ OpenAlex: GET https://api.openalex.org/works/doi:{doi}
  │     │   └─ Check open_access.is_oa + open_access.oa_url
  │     └─ Unpaywall: GET https://api.unpaywall.org/v2/{doi}?email=...
  │         └─ ⚠️ Unreliable (frequent HTTP 422); prefer OpenAlex
  │
  ├─ 3. Author preprint (if no arXiv ID from provider)
  │     └─ Search arXiv by author surname + topic keywords
  │     ✅ Representative Families (JACM 2016) found as arxiv:1304.4626
  │
  └─ 4. Publisher-specific acquisition
        │
        ├─ Campus IP (128.243.* / *.nottingham.ac.uk)?
        │     └─ Headed Chrome with auto-click (channel="chrome")
        │
        ├─ Off-campus with institutional access?
        │     ├─ EZProxy: https://ezproxy.{institution}/login?url={publisher_url}
        │     ├─ OpenAthens: https://go.openathens.net/redirector/{institution}?url=...
        │     └─ VPN: same as campus IP once connected
        │
        └─ Fully closed?
              └─ Skip, log to audit, ask user for manual download
```

## Network Scenarios

### Campus IP (current)
- Detection: IP starts with `128.243` or hostname ends with `.nottingham.ac.uk`
- Method: real Chrome with auto-click on PDF buttons
- Profile: `channel="chrome"` uses existing Chrome sessions
- Issue: Elsevier may still CAPTCHA if profile is empty temp dir

### VPN
- User connects via university VPN client (Cisco AnyConnect / GlobalProtect)
- Same as campus IP once connected
- Detection: ask user or check network interface

### Off-campus with EZProxy
- Pattern: `https://ezproxy.{inst}.ac.uk/login?url={publisher_url}`
- University of Nottingham EZProxy hostname varies by department
- Common patterns: `ezproxy.nottingham.ac.uk`, `login.ezproxy.nottingham.ac.uk`

### Off-campus with OpenAthens
- Pattern: `https://go.openathens.net/redirector/{institution}?url={publisher_url}`
- Institution ID for Nottingham: `nottingham.ac.uk`
- Requires Shibboleth login → browser-based auth

### No institutional access
- Skip paper, record in audit
- Alternative: email author for preprint (legal, often fast)

## Publisher-Specific Tactics

### Elsevier / ScienceDirect
- PDF button: `a:has-text("PDF")` or `a.link-button[href*="pdf"]`
- Direct PDF URL pattern: `{article_url}/pdfft?download=true`
- Issue: serves CAPTCHA if headless; real Chrome + existing session works
- Issue: `user_data_dir=""` creates empty profile without cookies
- Fix: use named profile with saved login → `uv run --project "<plugin-root>" lit-review login --profile elsevier`

### SciTePress
- Papers listed at: `https://www.scitepress.org/Papers/{year}/{paper_id}/`
- PDF button text varies: "Full Text", "Paper", "Download"
- Direct PDF pattern: `https://www.scitepress.org/Papers/{year}/{paper_id}/{paper_id}.pdf`
- Note: very recent papers (2026) may not have PDF available yet

### ACM Digital Library
- PDF button: `a:has-text("PDF")` or `a[aria-label*="PDF"]`
- Direct PDF: `https://dl.acm.org/doi/pdf/{doi}`
- Institutional access via EZProxy common

### IEEE Xplore
- Already handled by existing browser-based download in `download.py`
- Iframe-based PDF delivery (`stampPDF/getPDF.jsp`)

### Springer
- PDF: `a:has-text("Download PDF")` or direct `{url}.pdf`
- Many papers have OA via Springer Compact agreement (UK universities)

## Lessons Learned (CHP Review, 2026-07-24)

1. **arXiv is MVP**: 5/7 papers had arXiv versions. Always check first.
2. **Author name search beats title search**: preprint titles often differ.
3. **OpenAlex > Unpaywall**: more reliable, no rate limit issues.
4. **Very recent papers (<6 months) rarely have OA**: ZDD 2026 paper.
5. **Old papers without OA are hardest**: 2009 Discrete Math paper predates preprint culture.
6. **Real Chrome (`channel="chrome"`) beats headless**: CAPTCHA bypass.
7. **Empty Chrome profile doesn't carry cookies**: need saved profile or user's real profile.
8. **ScienceDirect auto-click finds button but download interception is tricky**: may need `page.on("download")` before click, or direct PDF URL navigation.
