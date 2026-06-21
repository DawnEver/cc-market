// lib.mjs — Sharp Review shared library (barrel).
// Concern modules live alongside this file; lib.mjs re-exports them so the many
// `from '../lib.mjs'` import sites stay stable:
//   - findings.mjs  category inference, follow-up renumber, merge + markdown render
//   - profiles.mjs  profile registry + weighted selection
//   - manifest.mjs  diff-manifest: classification, git -z parsing, render
// Regex/date/frontmatter helpers come from cc-market/shared/.

export {
  SR_ID_RE,
  SR_ID_PARSE_RE,
  SR_FINDING_HDR_RE as FINDING_HDR_RE,
  SR_STATUS_RE as STATUS_RE,
  todayISO,
  reviewFrontmatter,
  parseFindingsFromMarkdown,
} from './shared/lib.mjs';

export * from './findings.mjs';
export * from './profiles.mjs';
export * from './manifest.mjs';
