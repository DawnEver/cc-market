// engine/kill-tree.mjs — kill a child's WHOLE process tree. `child.kill()` signals only the
// root pid: on Windows a `shell:true` child is cmd.exe and the real process survives it; on
// POSIX a CLI's own children survive it. Windows: `taskkill /T /F`. POSIX: the child is
// spawned as a process-group leader (treeSpawnOptions) and the group is signalled.
import { spawnSync } from "../shared/spawn.mjs";

/** Spawn options that make killTree able to reach the tree. Spread into spawn(). */
export function treeSpawnOptions(platform = process.platform) {
  return platform === "win32" ? {} : { detached: true };
}

export function killTree(child, { platform = process.platform, _spawnSync = spawnSync, _kill = process.kill.bind(process) } = {}) {
  const pid = child?.pid;
  if (child?.exitCode != null || child?.signalCode != null) return; // already gone: never signal a reused pid
  if (!pid) { try { child?.kill?.("SIGKILL"); } catch {} return; }
  if (platform === "win32") {
    _spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    return;
  }
  try { _kill(-pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch {} }
}
