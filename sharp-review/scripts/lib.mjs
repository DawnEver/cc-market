// lib.mjs — Sharp Review shared library (barrel).
// Concern modules live in ./lib/; lib.mjs re-exports them so the many import
// sites stay stable:
//   - lib/findings.mjs  category inference, follow-up renumber, merge + markdown render
//   - lib/profiles.mjs  profile registry + weighted selection
//   - lib/manifest.mjs  diff-manifest: classification, git -z parsing, render
// Regex/date/frontmatter helpers come from cc-market/shared/.

export {
  SR_ID_RE,
  SR_ID_PARSE_RE,
  SR_FINDING_HDR_RE as FINDING_HDR_RE,
  SR_STATUS_RE as STATUS_RE,
  todayISO,
  reviewFrontmatter,
  parseFindingsFromMarkdown,
} from '../shared/lib.mjs';

export * from './lib/findings.mjs';
export * from './lib/profiles.mjs';
export * from './lib/manifest.mjs';
