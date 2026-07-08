// config.mjs — takeover's provider config surface. The provider-routing logic now lives
// in the canonical shared/providers.mjs (single source of truth, shared with the fabric
// plugin); this module re-exports it and keeps only SCRIPT_DIR, which is takeover-specific.
// Re-exported via scripts/lib.mjs.
import path from "node:path";
import { fileURLToPath } from "node:url";

// The plugin's scripts/ directory (this module lives in scripts/lib/). Kept pointing at
// scripts/ — not scripts/lib/ — so consumers like buildPrompt (join(SCRIPT_DIR, "..",
// "prompts")) resolve the plugin-root prompts/ dir exactly as before.
export const SCRIPT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export {
  getConfigPath,
  PROVIDER_ENV_KEYS,
  loadProviderEnv,
  loadProviderConfig,
  clearConfigCache,
  resolveModel,
  listModels,
} from "../../shared/providers.mjs";
