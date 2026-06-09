import { openDb, closeDb, insertSession, insertPrompt, insertToolCall, closeSession } from '../scripts/db.mjs';
import { getGitBranch, getProjectRoot, getProjectName, todayISO, summarizeToolInput, ERROR_LOG } from '../scripts/lib.mjs';
import { appendFileSync } from 'node:fs';

function logError(msg) {
  try { appendFileSync(ERROR_LOG, `[${new Date().toISOString()}] ${msg}\n`); } catch {}
}

async function main() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const input = JSON.parse(Buffer.concat(chunks).toString());
  const event = input.hook_event_name;

  try {
    const db = openDb();

    switch (event) {
      case 'SessionStart': {
        const cwd = input.cwd || process.cwd();
        const branch = getGitBranch(cwd);
        const projectPath = getProjectRoot(cwd);
        const project = getProjectName(cwd);

        insertSession({
          id: input.session_id,
          project,
          project_path: projectPath,
          branch,
          started_at: new Date().toISOString()
        });
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

      case 'SessionEnd': {
        closeSession(input.session_id, new Date().toISOString());

        // Run transcript ingest to backfill token/cost
        try {
          const { ingestTranscript } = await import('../scripts/ingest.mjs');
          ingestTranscript(input.transcript_path, input.session_id);
        } catch (e) {
          logError(`ingest failed: ${e.message}`);
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
