// engine/codex/turn.mjs — wait for one codex app-server turn and read its OUTCOME.
// Protocol (app-server v2, `codex app-server generate-json-schema`):
//   `error`          {error: TurnError, willRetry, threadId, turnId} — willRetry=false is final
//   `turn/completed` {threadId, turn: {id, status: completed|interrupted|failed, error: TurnError|null}}
//   TurnError        {message, codexErrorInfo, additionalDetails}
// A failed or interrupted turn rejects with a classified ProviderError; it never resolves.
import { ProviderError, httpErrorKind } from "../errors.mjs";

const INFO_KIND = {
  usageLimitExceeded: "exhausted",
  sessionBudgetExceeded: "exhausted",
  unauthorized: "auth",
  rateLimitExceeded: "rate_limit",
  serverOverloaded: "rate_limit",
};

/** TurnError -> one of ERROR_KINDS. */
export function classifyTurnError(error) {
  const info = error?.codexErrorInfo;
  if (typeof info === "string") return INFO_KIND[info] || "failed";
  if (info && typeof info === "object") {
    for (const v of Object.values(info)) {
      const k = httpErrorKind(v?.httpStatusCode);
      if (k !== "failed") return k;
    }
  }
  return "failed";
}

/**
 * Register handlers for one turn on `client` BEFORE the turn-starting request is sent.
 * `done` resolves with the completed Turn or rejects with a ProviderError (classified
 * failure, or `timeout`). Always call `dispose()` (removes handlers, clears the timer).
 */
export function watchTurn(client, { timeoutMs = 600000, label = "turn" } = {}) {
  let lastError = null;
  let timer;
  const onError = (p) => { if (!p?.willRetry) lastError = p?.error || null; };
  let onCompleted;
  const done = new Promise((resolve, reject) => {
    onCompleted = (params) => {
      const turn = params?.turn || {};
      if (turn.status === "failed" || turn.status === "interrupted") {
        const error = turn.error || lastError;
        const detail = error?.message || `turn ${turn.status}`;
        reject(new ProviderError(classifyTurnError(error), `codex ${label} ${turn.status}: ${detail}`));
      } else {
        resolve(turn);
      }
    };
    timer = setTimeout(() => reject(new ProviderError("timeout", `codex ${label}: no turn/completed after ${timeoutMs}ms`)), timeoutMs);
    timer.unref?.();
  });
  done.catch(() => {}); // a request that throws first must not leave an unhandled rejection
  client.onNotification("error", onError);
  client.onNotification("turn/completed", onCompleted);
  return {
    done,
    dispose() {
      clearTimeout(timer);
      client.removeNotificationHandler("error", onError);
      client.removeNotificationHandler("turn/completed", onCompleted);
    },
  };
}
