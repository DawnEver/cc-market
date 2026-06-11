import { openDb, closeDb, insertSession, insertPrompt, insertToolCall, closeSession, upsertTakeoverTokens, getMeta, setMeta } from '../scripts/db.mjs';
import { getGitBranch, getProjectRoot, getProjectName, getGitRemote, normalizeRemoteUrl, todayISO, summarizeToolInput, ERROR_LOG, rotateErrorLog } from '../scripts/lib.mjs';
import { scanTakeoverTraces, ingestTranscript } from '../scripts/ingest.mjs';
import { appendFileSync } from 'node:fs';

function logError(msg) {
  try { appendFileSync(ERROR_LOG, `[${new Date().toISOString()}] ${msg}\n`); } catch {}
}

async function main() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const input = JSON.parse(Buffer.concat(chunks).toString());
  const event = input.hook_event_name;

  rotateErrorLog();

  try {
    const db = openDb();

    switch (event) {
      case 'SessionStart': {
        const cwd = input.cwd || process.cwd();
        const branch = getGitBranch(cwd);
        const projectPath = getProjectRoot(cwd);
        const project = getProjectName(cwd);
        const remoteUrl = getGitRemote(cwd);
        const repoOrigin = remoteUrl ? normalizeRemoteUrl(remoteUrl) : projectPath;

        insertSession({
          id: input.session_id,
          project,
          project_path: projectPath,
          repo_origin: repoOrigin,
          branch,
          started_at: new Date().toISOString()
        });

        // Pull cross-device data so report/stats see other devices' latest
        try {
          const { hasKey } = await import('../scripts/crypto.mjs');
          if (hasKey() && process.env.TRACEME_SYNC_REMOTE) {
            const syncUrl = new URL('../scripts/sync.mjs', import.meta.url).href;
            const { pullSnapshots } = await import(syncUrl);
            for (let i = 0; i < 7; i++) {
              const d = new Date();
              d.setDate(d.getDate() - i);
              const dateStr = d.toISOString().slice(0, 10);
              await pullSnapshots(dateStr);
            }
          }
        } catch (e) {
          logError(`SessionStart auto-pull failed: ${e.message}`);
        }
        break;
      }

      case 'UserPromptSubmit': {
        const session = db.prepare('SELECT prompt_count FROM sessions WHERE id=?').get(input.session_id);
        const turnIndex = session ? session.prompt_count : 0;

        insertPrompt({
          id: `${input.session_id}_${turnIndex}`,
          session_id: input.session_id,
          turn_index: turnIndex,
          text: input.prompt || null,
          timestamp: new Date().toISOString()
        });

        db.prepare('UPDATE sessions SET prompt_count = prompt_count + 1 WHERE id=?').run(input.session_id);
        break;
      }

      case 'PreToolUse': {
        insertToolCall({
          id: input.tool_use_id || `${input.session_id}_tool_${Date.now()}`,
          session_id: input.session_id,
          prompt_id: null,
          tool_name: input.tool_name,
          summary: summarizeToolInput(input.tool_name, input.tool_input),
          timestamp: new Date().toISOString()
        });
        break;
      }

      case 'Stop':
      case 'SessionEnd': {
        const stopKey = `stop_processed_${input.session_id}`;
        if (getMeta(stopKey) === '1') break;
        setMeta(stopKey, '1');

        // Idempotency: skip if session already ended
        const s = db.prepare('SELECT ended_at FROM sessions WHERE id=?').get(input.session_id);
        if (s && s.ended_at) break;

        const session = db.prepare('SELECT project, repo_origin, started_at FROM sessions WHERE id=?').get(input.session_id);

        closeSession(input.session_id, new Date().toISOString());

        try {
          ingestTranscript(input.transcript_path, input.session_id);
        } catch (e) {
          logError(`ingest failed: ${e.message}`);
        }

        // Ingest takeover traces (NDJSON contract, no code dependency)
        try {
          if (session) {
            const date = session.started_at.slice(0, 10);
            const takeoverKey = `takeover_ts_${date}`;
            const lastTs = getMeta(takeoverKey);
            const { totalTokens, maxTs } = scanTakeoverTraces(date, lastTs);
            if (totalTokens > 0) {
              if (maxTs) setMeta(takeoverKey, maxTs);
              upsertTakeoverTokens(date, session.project, totalTokens, session.repo_origin || '');
            }
          }
        } catch (e) {
          logError(`takeover trace ingest failed: ${e.message}`);
        }

        // Push encrypted daily snapshot to sync repo (non-blocking)
        try {
          const { hasKey } = await import('../scripts/crypto.mjs');
          if (hasKey()) {
            const syncUrl = new URL('../scripts/sync.mjs', import.meta.url).href;
            const { pushSnapshot } = await import(syncUrl);
            await pushSnapshot();
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