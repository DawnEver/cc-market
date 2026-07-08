// lib.mjs — Takeover shared library (barrel).
// Concern modules live in ./lib/; lib.mjs re-exports them so the `./lib.mjs`
// import sites (mcp-server, tests) stay stable:
//   - lib/config.mjs   provider config/env (re-exports shared/providers.mjs)
//   - lib/errors.mjs   error taxonomy (TakeoverError + subclasses)
//   - lib/trace.mjs    TraceMe NDJSON + structured request logging
//   - lib/spawn.mjs    policy wrapper over the shared claude child engine
//   - lib/parse.mjs    command-block flags, prompt building, text extraction
//   - lib/callers.mjs  Codex companion (re-exports shared/anthropic-http.mjs)
// Engines live in ../shared/ (spawn-child, anthropic-http, codex/); this
// plugin only shapes prompts, picks engines per mode, and formats results.

export * from "./lib/config.mjs";
export * from "./lib/errors.mjs";
export * from "./lib/trace.mjs";
export * from "./lib/spawn.mjs";
export * from "./lib/parse.mjs";
export * from "./lib/callers.mjs";

export { findCodexBinary, checkCodexStatus } from "../shared/codex/discovery.mjs";
