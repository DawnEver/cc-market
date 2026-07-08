// errors.mjs — Takeover error taxonomy. Re-exported via scripts/lib.mjs.

export class TakeoverError extends Error {
  constructor(message, { code, retryable = false } = {}) {
    super(message);
    this.name = 'TakeoverError';
    this.code = code || 'TAKEOVER_ERROR';
    this.retryable = retryable;
  }
}

export class ConfigError extends TakeoverError {
  constructor(message) { super(message, { code: 'CONFIG_ERROR', retryable: false }); this.name = 'ConfigError'; }
}

export class ProviderError extends TakeoverError {
  constructor(message, retryable = false) { super(message, { code: 'PROVIDER_ERROR', retryable }); this.name = 'ProviderError'; }
}

export class TimeoutError extends TakeoverError {
  constructor(message) { super(message, { code: 'TIMEOUT_ERROR', retryable: true }); this.name = 'TimeoutError'; }
}

export class AuthError extends TakeoverError {
  constructor(message) { super(message, { code: 'AUTH_ERROR', retryable: false }); this.name = 'AuthError'; }
}
