import { spawn } from "node:child_process";
import path from "node:path";
import { findCodexBinary } from "./discovery.mjs";

export function generateImage(prompt, opts = {}) {
  const codexPath = opts.codexPath || findCodexBinary();
  const cwd = opts.cwd || process.cwd();

  const instruction = [
    "Use the imagegen skill. Built-in image_gen tool path only — do not use the CLI fallback.",
    "",
    `Generate an image: ${prompt}`,
    opts.size ? `Size: ${opts.size}` : "",
    opts.quality === "hd" ? "Use HD quality." : "",
    opts.output ? `Save to: ${opts.output}` : "Save to the current directory.",
    "",
    "For each saved image, print exactly one line:",
    "SAVED: <absolute path>",
  ].filter(Boolean).join("\n");

  return spawnCodex(codexPath, ["exec", "--full-auto", "--skip-git-repo-check", "-C", cwd, "--", instruction], 300000);
}

export function editImage(prompt, imagePath, opts = {}) {
  const codexPath = opts.codexPath || findCodexBinary();
  const cwd = opts.cwd || process.cwd();
  const absImage = path.resolve(cwd, imagePath);

  const instruction = [
    "Use the imagegen skill. Built-in image_gen tool path only — do not use the CLI fallback.",
    "",
    "The image attached via --image is the edit target. Preserve unrelated parts unless the user request says otherwise.",
    "",
    `Edit this image: ${prompt}`,
    opts.output ? `Save edited image to: ${opts.output}` : "Save to the current directory.",
    "",
    "For each saved image, print exactly one line:",
    "SAVED: <absolute path>",
  ].filter(Boolean).join("\n");

  return spawnCodex(codexPath, ["exec", "--full-auto", "--skip-git-repo-check", "-C", cwd, "--image", absImage, "--", instruction], 300000);
}

function spawnCodex(codexPath, args, timeout) {
  const useCmdExe = process.platform === "win32" && (codexPath.endsWith(".cmd") || codexPath.endsWith(".bat"));
  const cmd = useCmdExe ? "cmd.exe" : codexPath;
  const cmdArgs = useCmdExe ? ["/d", "/s", "/c", codexPath, ...args] : args;

  return new Promise((resolve, reject) => {
    const child = spawn(cmd, cmdArgs, {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
      timeout,
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => { stderr += d.toString(); });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        const savedPaths = parseSavedPaths(stdout);
        resolve({
          content: [{ type: "text", text: stdout.trim() || "(image generated)" }],
          savedPaths,
        });
      } else {
        reject(new Error(`codex exec exited ${code}: ${stderr.trim()}`));
      }
    });
  });
}

function parseSavedPaths(output) {
  const paths = [];
  for (const line of output.split("\n")) {
    const m = line.match(/^SAVED:\s+(.+)$/);
    if (m) paths.push(m[1].trim());
  }
  return paths;
}
