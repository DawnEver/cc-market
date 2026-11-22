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

// ── Antigravity (agy) ──
// agy hook payloads are camelCase (conversationId, hookEventName, toolCall{name,args},
// workspacePaths); the generated hooks.json also passes `--host agy` and agy sets
// PLUGIN_ROOT, ANTIGRAVITY_CONVERSATION_ID and ANTIGRAVITY_AGENT=1.
const AGY_PAYLOAD_KEYS = ['conversationId', 'hookEventName', 'toolCall', 'workspacePaths'];
const CLAUDE_PAYLOAD_KEYS = ['session_id', 'hook_event_name', 'tool_name', 'tool_input', 'transcript_path', 'prompt', 'user_prompt', 'stop_hook_active', 'background_tasks'];

export function isAgyHost(input = {}, env = process.env, argv = process.argv) {
  const at = argv.indexOf('--host');
  if (at >= 0) return argv[at + 1] === 'agy';
  if (argv.includes('--host=agy')) return true;
  if (input && typeof input === 'object') {
    if (AGY_PAYLOAD_KEYS.some(k => k in input)) return true;
    if (CLAUDE_PAYLOAD_KEYS.some(k => k in input)) return false;
  }
  if (env.CLAUDE_PLUGIN_ROOT || env.CLAUDE_CODE_SESSION_ID || isCodexHost(env)) return false;
  return Boolean(env.ANTIGRAVITY_CONVERSATION_ID || env.ANTIGRAVITY_AGENT === '1' || (env.PLUGIN_ROOT && !env.CLAUDE_PLUGIN_ROOT));
}

// Codex hook session_id can name a parent. Transient gates belong to the actual
// executing thread; an unknown thread must not borrow that parent's counters.
export function hookSessionKey(input = {}, env = process.env, argv = process.argv) {
  const agy = id(input.conversationId);
  if (agy) return agy;
  const native = id(input.thread_id) || id(input.agent_id);
  const file = String(input.transcript_path ?? '').split(/[\\/]/).at(-1);
  const rollout = /^rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(file)?.[1];
  if (isCodexHost(env)) return native || rollout || id(env.CODEX_THREAD_ID);
  if (isAgyHost(input, env, argv)) return id(input.conversationId) || id(env.ANTIGRAVITY_CONVERSATION_ID);
  return native || id(input.session_id) || id(env.CLAUDE_CODE_SESSION_ID) || id(input.transcript_path);
}

// agy tool name → the Claude tool name the hook logic already judges.
export const AGY_TOOL_NAMES = {
  write_file: 'Write', write_to_file: 'Write',
  edit_file: 'Edit', replace_file_content: 'Edit', multi_replace_file_content: 'MultiEdit',
  run_command: 'Bash',
  read_file: 'Read', view_file: 'Read',
  grep_search: 'Grep', find_by_name: 'Glob',
};
// agy tool argument → Claude tool_input key.
const AGY_ARG_NAMES = {
  Path: 'file_path', TargetFile: 'file_path', AbsolutePath: 'file_path',
  CommandLine: 'command', Cwd: 'cwd',
  SearchPath: 'path', SearchDirectory: 'path', Query: 'pattern', Pattern: 'pattern',
  Content: 'content', CodeContent: 'content',
  Replacement: 'new_string', ReplacementContent: 'new_string',
  Target: 'old_string', TargetContent: 'old_string',
};
// Claude tool name(s) → agy tool name(s), for hooks.json matchers (gen-agy.mjs).
export const CLAUDE_TO_AGY_TOOLS = {
  Write: ['write_file', 'write_to_file'], Edit: ['edit_file', 'replace_file_content'], MultiEdit: ['multi_replace_file_content'],
  NotebookEdit: [], Bash: ['run_command'], PowerShell: ['run_command'],
  Read: ['read_file', 'view_file'], Grep: ['grep_search'], Glob: ['find_by_name'],
};

// agy's transcript double-encodes argument values as JSON strings ("\"npm test\"").
const decodeArg = v => {
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return v; }
};

export function agyToolInput(args = {}) {
  const out = {};
  for (const [k, v] of Object.entries(args && typeof args === 'object' ? args : {})) {
    const value = decodeArg(v);
    out[k] = value;
    const mapped = AGY_ARG_NAMES[k];
    if (mapped && out[mapped] === undefined) out[mapped] = value;
  }
  return out;
}

/**
 * Normalize a hook payload to the Claude snake_case shape the hooks read. A non-agy payload
 * is returned unchanged; an agy payload keeps its own keys and gains session_id,
 * transcript_path, cwd (workspacePaths[0]), hook_event_name, prompt, tool_name/tool_input.
 */
export function normalizeHookInput(input = {}, env = process.env, argv = process.argv) {
  if (!input || typeof input !== 'object' || !isAgyHost(input, env, argv)) return input || {};
  const out = { ...input, host: 'agy' };
  out.session_id ??= id(input.conversationId) || id(env.ANTIGRAVITY_CONVERSATION_ID) || input.conversationId;
  out.transcript_path ??= input.transcriptPath;
  const root = Array.isArray(input.workspacePaths) && input.workspacePaths[0];
  out.cwd = root || input.cwd || out.cwd;
  out.hook_event_name ??= input.hookEventName;
  if (typeof input.lastUserInput === 'string') {
    const t = input.lastUserInput;
    const m = /<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/.exec(t);
    out.prompt ??= (m ? m[1] : t).trim();
  }
  // Stop: a Stop hook already kept this turn going ≙ Claude's stop_hook_active; background
  // work still running ≙ background_tasks.
  if (input.continuationActive) out.stop_hook_active = true;
  if (input.fullyIdle === false && !Array.isArray(out.background_tasks)) out.background_tasks = ['agy-background'];
  if (input.toolCall) {
    out.tool_name = AGY_TOOL_NAMES[input.toolCall.name] || input.toolCall.name;
    out.tool_input = agyToolInput(input.toolCall.args);
  }
  return out;
}

// PreInvocation fires before EVERY model call of a turn; the UserPromptSubmit port must act
// once per turn. invocationNum is 0-based like executionNum (protojson omits the zero).
export const isFirstInvocation = (input = {}) => !Number(input.invocationNum);

/**
 * One host-shaped hook result. `kind`: 'deny' (PreToolUse refusal), 'block' (Stop: keep the
 * agent going) or 'context' (SessionStart / prompt context). Returns { stdout, stderr, code }.
 * agy always gets a JSON object on stdout ({} for nothing to say).
 */
export function hookOutput({ host, event, kind, reason = '', input = {} }) {
  if (host === 'agy') {
    if (kind === 'deny') return { stdout: JSON.stringify({ decision: 'deny', reason }), stderr: '', code: 0 };
    // PreToolUse requires a non-empty decision (`{}` is treated as a denial); `ask` defers to
    // the user's configured toolPermission (`always-proceed` proceeds silently; normal prompts).
    if (event === 'PreToolUse') return { stdout: JSON.stringify({ decision: 'ask' }), stderr: '', code: 0 };
    if (kind === 'block') {
      if (input.continuationActive) return { stdout: '{}', stderr: '', code: 0 };
      return { stdout: JSON.stringify({ decision: 'continue', reason }), stderr: '', code: 0 };
    }
    if (kind === 'context' && reason) {
      return { stdout: JSON.stringify({ injectSteps: [{ systemMessage: { systemMessage: reason } }] }), stderr: '', code: 0 };
    }
    return { stdout: '{}', stderr: '', code: 0 };
  }
  if (kind === 'deny') {
    return { stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: event || 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }), stderr: '', code: 0 };
  }
  if (kind === 'block') return { stdout: '', stderr: reason, code: 2 };
  if (kind === 'context' && reason) {
    return { stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: reason } }), stderr: '', code: 0 };
  }
  return { stdout: '', stderr: '', code: 0 };
}

/** Write a hookOutput() result and exit with its code once the streams drain. */
export function emitHookOutput(result) {
  const { stdout = '', stderr = '', code = 0 } = result || {};
  const done = () => process.exit(code);
  const writeErr = () => (stderr ? process.stderr.write(stderr, done) : done());
  if (stdout) process.stdout.write(stdout, writeErr); else writeErr();
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
    // agy: edits by tool name; a skill is invoked by reading its SKILL.md.
    if (['write_file', 'edit_file', 'write_to_file', 'replace_file_content', 'multi_replace_file_content'].includes(name)) hasEdits = true;
    const agyFile = args.Path || args.TargetFile || args.AbsolutePath;
    if (['read_file', 'view_file', 'write_file', 'edit_file', 'write_to_file', 'replace_file_content', 'multi_replace_file_content'].includes(name) && typeof agyFile === 'string') readPaths.add(agyFile);
    if ((name === 'read_file' || name === 'view_file') && /[\\/]rem[\\/]skills[\\/]rem[\\/]SKILL\.md$/.test(agyFile || '')) calledRem = true;
  };
  for (const row of transcript) {
    const message = row?.message;
    for (const block of Array.isArray(message?.content) ? message.content : []) {
      if (block?.type === 'tool_use') inspectTool(block.name, block.input);
    }
    if (message?.role === 'assistant') {
      const t = text(message.content); if (t) lastAssistantText = t;
    } else if (message?.role === 'user' || row?.type === 'user') lastAssistantText = '';
    // agy transcript.jsonl: { type: USER_INPUT | PLANNER_RESPONSE, content, tool_calls[{name,args}] }
    if (row?.type === 'USER_INPUT') lastAssistantText = '';
    if (row?.type === 'PLANNER_RESPONSE') {
      for (const call of Array.isArray(row.tool_calls) ? row.tool_calls : []) inspectTool(call?.name, agyToolInput(call?.args));
      if (typeof row.content === 'string' && row.content.trim()) lastAssistantText = row.content;
    }
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
  return { hasEdits, lastAssistantText, waitingForInput: /[?\uFF1F]$/.test(lastAssistantText.trim()), readPaths: [...readPaths], calledRem };
}

export const hasCodeEdits = transcript => normalizeHookFacts(transcript).hasEdits;
export const isAwaitingInput = (transcript, input) => normalizeHookFacts(transcript, input).waitingForInput;
export const extractTaskSummary = (transcript, input) => normalizeHookFacts(transcript, input).lastAssistantText.slice(0, 800) || '(no summary)';
