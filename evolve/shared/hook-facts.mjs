// Minimal host-neutral facts for lifecycle gates. Structured events only: do not try
// to infer file I/O from arbitrary shell commands or expose reasoning/tool output.
export function isCodexHost(env = process.env) {
  const root = env.CLAUDE_PLUGIN_ROOT || '';
  if (/[\\/]\.codex[\\/]/.test(root)) return true;
  if (/[\\/]\.claude[\\/]/.test(root)) return false;
  return Boolean(env.CODEX_HOME || env.CODEX_SANDBOX || env.CODEX_THREAD_ID);
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
