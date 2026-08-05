# cc-latex Invariants

Dev-only constraints (not injected when skills run in a user's project).

- **Runtime boundary**: skills see only their own `SKILL.md`, `reference/*.md`, and the
  host project. Everything a skill needs must be in-band — including the
  `${CLAUDE_PLUGIN_ROOT}` script path, which is available at runtime.
- **One source of truth**: texcount flags, output parsing, and the table format live in
  `scripts/word-count.mjs`. Do not restate them in `SKILL.md` or here — link instead.
  Two copies of the same fact (one runtime, one dev-only) drift silently.
- **windowsHide**: every `spawnSync` in `scripts/word-count.mjs` passes
  `windowsHide: true` (Windows console flash rule).
- **texcount compatibility**: parsing targets texcount 3.x (3.1.1 pinned in the tests).
  If the output format changes upstream, update the fixture + parser together.
- **CRLF**: Windows texcount emits `\r\n`; the parser normalizes per line — do not
  "simplify" this away.
