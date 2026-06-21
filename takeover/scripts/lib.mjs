// lib.mjs — Takeover shared library (barrel).
// Concern modules live in ./lib/; lib.mjs re-exports them so the `./lib.mjs`
// import sites (mcp-server, tests) stay stable:
//   - lib/config.mjs   provider config/env, model resolution, model listing
//   - lib/errors.mjs   error taxonomy (TakeoverError + subclasses)
//   - lib/trace.mjs    TraceMe NDJSON + structured request logging
//   - lib/spawn.mjs    claude binary resolution + spawn claude -p
//   - lib/parse.mjs    command-block flags, prompt building, text extraction
//   - lib/callers.mjs  Anthropic API caller + Codex companion
// Codex binary discovery is re-exported straight from ./codex/.

export * from "./lib/config.mjs";
export * from "./lib/errors.mjs";
export * from "./lib/trace.mjs";
export * from "./lib/spawn.mjs";
export * from "./lib/parse.mjs";
export * from "./lib/callers.mjs";

export { findCodexBinary, checkCodexStatus } from "./codex/discovery.mjs";
