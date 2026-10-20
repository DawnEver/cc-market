// engine/errors.mjs — the one error taxonomy. A provider failure is a ProviderError whose
// `kind` is one of ERROR_KINDS (ai-lab's ProviderError.kind, plus `failed` for a turn or
// call that failed for any other reason); a caller mistake is a ConfigError.

export const ERROR_KINDS = ["exhausted", "auth", "rate_limit", "timeout", "unsupported", "failed"];

export class ProviderError extends Error {
  constructor(kind, message) {
    if (!ERROR_KINDS.includes(kind)) {
      throw new TypeError(`undeclared error kind "${kind}" (declared: ${ERROR_KINDS.join(", ")})`);
    }
    super(`[${kind}] ${message}`);
    this.name = "ProviderError";
    this.kind = kind;
  }
}

export class ConfigError extends Error {
  constructor(message) { super(message); this.name = "ConfigError"; }
}

export function httpErrorKind(status) {
  if (status === 401 || status === 403) return "auth";
  if (status === 402) return "exhausted";
  if (status === 429) return "rate_limit";
  return "failed";
}
