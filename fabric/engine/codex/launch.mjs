// Codex bootstrap/status processes only. Prompts travel over JSON-RPC, never a shell.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

function envValue(env, name) {
  return env[Object.keys(env).find(key => key.toLowerCase() === name.toLowerCase())];
}

function resolveWindowsCommand(command, env) {
  const extensions = path.extname(command) ? [''] : [...(envValue(env, 'PATHEXT') || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean), ''];
  const directories = path.isAbsolute(command) || /[\\/]/.test(command)
    ? [''] : (envValue(env, 'PATH') || '').split(';').filter(Boolean).map(dir => dir.replace(/^"|"$/g, ''));
  for (const directory of directories) for (const extension of extensions) {
    const file = directory ? path.join(directory, command + extension) : path.resolve(command + extension);
    try { if (fs.statSync(file).isFile()) return file; } catch { /* keep looking */ }
  }
  return null;
}

export function prepareCodexLaunch(command, args, { env = process.env, platform = process.platform } = {}) {
  if (platform !== 'win32') return { command, args, options: { env, shell: false } };
  const binary = resolveWindowsCommand(command, env);
  // Even a batch-looking unresolved value is data, not shell source.
  if (!binary || !/\.(?:cmd|bat)$/i.test(binary)) return { command: binary || command, args, options: { env, shell: false } };
  // These are fixed internal subcommands/flags, not user prompts. Fail closed rather
  // than claiming a generic arbitrary-argv contract through a batch shim's %*.
  if (args.some(arg => !/^[a-z0-9_-]+$/i.test(arg))) throw new Error('Unsafe Codex batch bootstrap argument');
  const key = `FABRIC_CODEX_BINARY_${randomUUID().replaceAll('-', '')}`;
  // cmd expands this variable once. A literal %NAME% inside the path is not expanded
  // recursively; quotes protect spaces/metacharacters and /v:off disables ! expansion.
  const line = `"%${key}%" ${args.join(' ')}`;
  return {
    command: envValue(env, 'ComSpec') || 'cmd.exe',
    args: ['/d', '/s', '/v:off', '/c', `"${line}"`],
    options: { env: { ...env, [key]: binary }, shell: false, windowsVerbatimArguments: true },
  };
}
