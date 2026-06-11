import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, basename } from 'node:path';
import { openDb, getMeta, setMeta, replaceSession } from './db.mjs';
import { getProjectRoot, getGitRemote, normalizeRemoteUrl } from './lib.mjs';
import { calcCost } from './pricing.mjs';

// Claude Code writes one transcript per session under ~/.claude/projects/<enc-cwd>/<sessionId>.jsonl.
// Each line carries model + usage, tool_use blocks, cwd, gitBranch, timestamp — everything traceme
// needs. The only thing missing is the git remote (for cross-device repo dedup), resolved per cwd.
export function projectsDir() {
  return process.env.TRACEME_PROJECTS_DIR || join(homedir(), '.claude', 'projects');
}

// Resolve git identity for a cwd once and cache it — distinct cwds are few, git calls are slow.
function resolveRepo(cwd) {
  if (!cwd) return { project: 'unknown', project_path: '', repo_origin: '' };
  const key = `repo:${cwd}`;
  const cached = getMeta(key);
  if (cached) { try { return JSON.parse(cached); } catch {} }
  const project_path = getProjectRoot(cwd);
  const remote = getGitRemote(cwd);
  const repo_origin = remote ? normalizeRemoteUrl(remote) : project_path;
  const info = { project: basename(project_path) || 'unknown', project_path, repo_origin };
  setMeta(key, JSON.stringify(info));
  return info;
}

function isRealPrompt(e) {
  if (e.type !== 'user' || e.isMeta || e.message?.role !== 'user') return false;
  const content = e.message.content;
  if (typeof content === 'string') return !content.includes('<local-command') && !content.includes('<command-name>');
  if (Array.isArray(content)) return content.some(c => c.type === 'text' && c.text);
  return false;
}

// Reduce a parsed transcript to a session fact record. Assistant messages are
// deduped by message.id (retries re-emit the same id). Returns null for
// meta-only / empty transcripts (no timestamped content).
export function parseSession(entries) {
  let cwd = null, branch = null, started = null, ended = null, promptCount = 0;
  const seen = new Set();
  const models = {};
  const tools = {};
  const skills = {};
  let input = 0, output = 0, cacheRead = 0, cacheCreate = 0, cost = 0;

  for (const e of entries) {
    if (e.cwd && !cwd) cwd = e.cwd;
    if (e.gitBranch && !branch) branch = e.gitBranch;
    if (e.timestamp) {
      if (!started || e.timestamp < started) started = e.timestamp;
      if (!ended || e.timestamp > ended) ended = e.timestamp;
    }
    if (isRealPrompt(e)) promptCount++;

    if (e.type === 'assistant' && e.message?.usage && e.message.id && !seen.has(e.message.id)) {
      seen.add(e.message.id);
      const model = e.message.model || 'unknown';
      // Skip Claude Code's injected placeholder turns (no real API spend).
      if (model === '<synthetic>') continue;
      const u = e.message.usage;
      const inp = u.input_tokens || 0, out = u.output_tokens || 0;
      const cr = u.cache_read_input_tokens || 0, cc = u.cache_creation_input_tokens || 0;
      const c = calcCost(u, model);
      input += inp; output += out; cacheRead += cr; cacheCreate += cc; cost += c;
      const m = models[model] || (models[model] = { requests: 0, input: 0, output: 0, cache_read: 0, cache_creation: 0, cost: 0 });
      m.requests++; m.input += inp; m.output += out; m.cache_read += cr; m.cache_creation += cc; m.cost += c;
      for (const block of (e.message.content || [])) {
        if (block && block.type === 'tool_use' && block.name) {
          tools[block.name] = (tools[block.name] || 0) + 1;
          if (block.name === 'Skill' && block.input?.skill) {
            const sk = block.input.skill;
            skills[sk] = (skills[sk] || 0) + 1;
          }
        }
      }
    }
  }

  if (!started) return null;
  const total = input + output + cacheRead + cacheCreate;
  const topModel = Object.entries(models).sort((a, b) => b[1].requests - a[1].requests)[0]?.[0] || null;
  return {
    cwd, branch, started, ended, promptCount,
    input, output, cacheRead, cacheCreate, total, cost, topModel,
    models: Object.entries(models).map(([model, m]) => ({ model, ...m })),
    tools: Object.entries(tools).map(([tool_name, count]) => ({ tool_name, count })),
    skills: Object.entries(skills).map(([skill_name, count]) => ({ skill_name, count })),
  };
}

function scanOne(path, sessionId) {
  let raw;
  try { raw = readFileSync(path, 'utf8'); } catch { return null; }
  const entries = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { entries.push(JSON.parse(line)); } catch {}
  }
  const p = parseSession(entries);
  if (!p) return null;
  const repo = resolveRepo(p.cwd);
  replaceSession({
    id: sessionId,
    date: p.started.slice(0, 10),
    project: repo.project,
    project_path: repo.project_path,
    repo_origin: repo.repo_origin,
    branch: p.branch,
    started_at: p.started,
    ended_at: p.ended,
    prompt_count: p.promptCount,
    input_tokens: p.input,
    output_tokens: p.output,
    cache_read_tokens: p.cacheRead,
    cache_creation_tokens: p.cacheCreate,
    total_tokens: p.total,
    total_cost: p.cost,
    top_model: p.topModel,
    models: p.models,
    tools: p.tools,
    skills: p.skills,
  });
  return p;
}

// Incremental sweep over all transcripts. A per-file (size:mtime) cursor in
// traceme_meta lets unchanged files skip instantly; changed files are fully
// re-parsed and the session row replaced (idempotent). Pass force to ignore
// cursors and rebuild everything.
export function scanAll({ force = false } = {}) {
  openDb();
  const root = projectsDir();
  const stats = { files: 0, scanned: 0, sessions: 0 };
  if (!existsSync(root)) return stats;

  for (const projDir of readdirSync(root)) {
    const dir = join(root, projDir);
    let dst;
    try { dst = statSync(dir); } catch { continue; }
    if (!dst.isDirectory()) continue;

    let names;
    try { names = readdirSync(dir); } catch { continue; }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue;
      stats.files++;
      const path = join(dir, name);
      let fst;
      try { fst = statSync(path); } catch { continue; }
      const cursorKey = `cur:${path}`;
      const sig = `${fst.size}:${Math.round(fst.mtimeMs)}`;
      if (!force && getMeta(cursorKey) === sig) continue;

      const sessionId = name.replace(/\.jsonl$/, '');
      const res = scanOne(path, sessionId);
      stats.scanned++;
      if (res) stats.sessions++;
      setMeta(cursorKey, sig);
    }
  }
  return stats;
}
