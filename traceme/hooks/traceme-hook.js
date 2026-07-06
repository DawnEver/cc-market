import { openDb, closeDb, getMeta, setMeta, upsertTakeoverTokens } from '../scripts/db.mjs';
import { getProjectName, getGitRemote, getProjectRoot, normalizeRemoteUrl, todayISO, ERROR_LOG, rotateErrorLog } from '../scripts/lib.mjs';
import { scanTakeoverTraces } from '../scripts/ingest.mjs';
import { scanAll } from '../scripts/scan.mjs';
import { appendFileSync } from 'node:fs';
import { spawn } from "../shared/spawn.mjs";
import { fileURLToPath } from 'node:url';

function logError(msg) {
  try { appendFileSync(ERROR_LOG, `[${new Date().toISOString()}] ${msg}\n`); } catch {}
}

// Push at most once per this interval (per device) to avoid a git commit/push on
// every turn; SessionEnd always pushes regardless.
const PUSH_INTERVAL_MS = 10 * 60 * 1000;

async function main() {
  let event = 'unknown';

  rotateErrorLog();

  try {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString();
    if (!raw.trim()) {
      // Empty stdin — nothing to do (e.g. manual hook invocation)
      return;
    }
    const input = JSON.parse(raw);
    event = input.hook_event_name || 'unknown';

    openDb();

    switch (event) {
      case 'SessionStart': {
        // Pull cross-device data so report/stats see other devices' latest.
        try {
          const { hasKey } = await import('../scripts/crypto.mjs');
          if (hasKey() && process.env.TRACEME_SYNC_REMOTE) {
            const syncUrl = new URL('../scripts/sync.mjs', import.meta.url).href;
            const { pullSnapshots } = await import(syncUrl);
            for (let i = 0; i < 7; i++) {
              const d = new Date();
              d.setDate(d.getDate() - i);
              await pullSnapshots(d.toISOString().slice(0, 10));
            }
          }
        } catch (e) {
          logError(`SessionStart auto-pull failed: ${e.message}`);
        }
        break;
      }

      case 'Stop':
      case 'SessionEnd': {
        // Incremental, idempotent sweep of all transcripts — derives token/tool
        // data straight from jsonl. Cheap on every turn (unchanged files skip).
        try {
          scanAll();
        } catch (e) {
          logError(`scan failed: ${e.message}`);
        }

        // Fold in takeover traces (NDJSON contract, not in the transcript).
        try {
          const cwd = input.cwd || process.cwd();
          const project = getProjectName(cwd);
          const remote = getGitRemote(cwd);
          const repoOrigin = remote ? normalizeRemoteUrl(remote) : getProjectRoot(cwd);
          const date = todayISO();
          const takeoverKey = `takeover_ts_${date}`;
          const lastTs = getMeta(takeoverKey);
          const { totalTokens, maxTs } = scanTakeoverTraces(date, lastTs);
          if (totalTokens > 0) {
            if (maxTs) setMeta(takeoverKey, maxTs);
            upsertTakeoverTokens(date, project, totalTokens, repoOrigin || '');
          }
        } catch (e) {
          logError(`takeover trace ingest failed: ${e.message}`);
        }

        // Push encrypted daily snapshot. On Stop the session continues, so push
        // inline (throttled). On SessionEnd the session is tearing down and Claude
        // Code won't wait for a network git push — doing it inline gets "Hook
        // cancelled" — so detach a background process and return immediately.
        try {
          const { hasKey } = await import('../scripts/crypto.mjs');
          if (hasKey()) {
            const last = parseInt(getMeta('last_push_ms') || '0', 10);
            const due = event === 'SessionEnd' || (Date.now() - last) > PUSH_INTERVAL_MS;
            if (due) {
              setMeta('last_push_ms', String(Date.now()));
              if (event === 'SessionEnd') {
                const cli = fileURLToPath(new URL('../scripts/traceme-cli.mjs', import.meta.url));
                const child = spawn(process.execPath, [cli, 'sync', 'push'], {
                  detached: true,
                  stdio: 'ignore',
                });
                child.unref();
              } else {
                const syncUrl = new URL('../scripts/sync.mjs', import.meta.url).href;
                const { pushSnapshot } = await import(syncUrl);
                await pushSnapshot();
              }
            }
          }
        } catch (e) {
          logError(`auto-sync push failed: ${e.message}`);
        }
        break;
      }
    }

    closeDb();
  } catch (e) {
    logError(`${event}: ${e.message}`);
    // Never exit non-zero — observability must be invisible
  }
}

await main();
