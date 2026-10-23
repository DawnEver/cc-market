// Minimal host-neutral facts for lifecycle gates. Structured events only: do not try
// to infer file I/O from arbitrary shell commands or expose reasoning/tool output.
import path from 'node:path';

export function isCodexHost(env = process.env) {
  const root = env.CLAUDE_PLUGIN_ROOT || '';
  let owner;
  for (const [home, codex] of [[env.CODEX_HOME, true], [env.CLAUDE_CONFIG_DIR, false]]) {
    if (!root || !home) continue;
    const paths = /^[a-z]:[\\/]/i.test(home) ? path.win32 : path;
    const plugins = paths.resolve(home, 'plugins');
    const relative = paths.relative(plugins, paths.resolve(root));
    if (relative !== '..' && !relative.startsWith(`..${paths.sep}`) && !paths.isAbsolute(relative) &&
        (!owner || plugins.length > owner.depth)) owner = { codex, depth: plugins.length };
  }
  if (owner) return owner.codex;
  if (/[\\/]\.codex[\\/]/.test(root)) return true;
  if (/[\\/]\.claude(?:-[^\\/]+)?[\\/]/.test(root)) return false;
  return Boolean(env.CODEX_HOME || env.CODEX_SANDBOX || env.CODEX_THREAD_ID || env.CODEX_SESSION_ID || env.HARNESS_AGENT === 'codex');
}

const id = value => typeof value === 'string' && value.trim() ? value.trim() : null;

// Codex hook session_id can name a parent. Transient gates belong to the actual
// executing thread; an unknown thread must not borrow that parent's counters.
export function hookSessionKey(input = {}, env = process.env) {
  const native = id(input.thread_id) || id(input.agent_id);
  const file = String(input.transcript_path ?? '').split(/[\\/]/).at(-1);
  const rollout = /^rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(file)?.[1];
  if (isCodexHost(env)) return native || rollout || id(env.CODEX_THREAD_ID);
  return native || id(input.session_id) || id(env.CLAUDE_CODE_SESSION_ID) || id(input.transcript_path);
}

export function hasRemReservation(hook = {}, now = Date.now(), exceptKey) {
  return Object.entries(hook.sessions ?? {}).some(([key, session]) =>
    key !== exceptKey && session?.remPending && session.requestExpiresAt > now);
}

const text = content => Array.isArray(content) ? content
  .filter(b => ['text', 'Text', 'output_text'].includes(b?.type))
  .map(b => b.text || '').join('\n') : '';

export function normalizeHookFacts(transcript = [], input = {}) {
  let hasEdits = false, lastAssistantText = '', calledRem = false;
  const readPaths = new Set();
  const inspectTool = (name, args = {}) => {
    if (!args || typeof args !== 'object') args = {};
    if (['Edit', 'Write', 'NotebookEdit', 'apply_patch'].includes(name)) hasEdits = true;
    if (['Read', 'Edit', 'Write', 'NotebookEdit'].includes(name) && typeof args.file_path === 'string') readPaths.add(args.file_path);
    if (name === 'Skill' && /(^|:)rem$/.test(args.skill || '')) calledRem = true;
  };
  for (const row of transcript) {
    const message = row?.message;
    for (const block of Array.isArray(message?.content) ? message.content : []) {
      if (block?.type === 'tool_use') inspectTool(block.name, block.input);
    }
    if (message?.role === 'assistant') {
      const t = text(message.content); if (t) lastAssistantText = t;
    } else if (message?.role === 'user' || row?.type === 'user') lastAssistantText = '';
    const p = row?.payload;
    if (row?.type === 'event_msg' && p?.type === 'agent_message' && typeof p.message === 'string') lastAssistantText = p.message;
    const item = row?.type === 'event_msg' && p?.type === 'item_completed' ? p.item : null;
    if (['FileChange', 'fileChange'].includes(item?.type)) hasEdits = true;
    if (['AgentMessage', 'agentMessage'].includes(item?.type)) lastAssistantText = item.text || text(item.content) || lastAssistantText;
    if (['UserMessage', 'userMessage'].includes(item?.type)) lastAssistantText = '';
    if (row?.type === 'response_item' && p?.type === 'message') {
      if (p.role === 'assistant') lastAssistantText = text(p.content) || lastAssistantText;
      if (p.role === 'user') lastAssistantText = '';
    }
    if (row?.type === 'response_item' && ['function_call', 'custom_tool_call'].includes(p?.type)) {
      let args = p.arguments;
      if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = {}; } }
      inspectTool(p.name, args);
    }
  }
  if (typeof input.last_assistant_message === 'string') lastAssistantText = input.last_assistant_message;
  return { hasEdits, lastAssistantText, waitingForInput: /[?？]$/.test(lastAssistantText.trim()), readPaths: [...readPaths], calledRem };
}

export const hasCodeEdits = transcript => normalizeHookFacts(transcript).hasEdits;
export const isAwaitingInput = (transcript, input) => normalizeHookFacts(transcript, input).waitingForInput;
export const extractTaskSummary = (transcript, input) => normalizeHookFacts(transcript, input).lastAssistantText.slice(0, 800) || '(no summary)';
