import path from "node:path";
import { CodexAppServerClient } from "../../shared/codex/app-server.mjs";

// ── App-server image generation ─────────────────────────────────────

export async function generateImage(prompt, opts = {}) {
  const { cwd = process.cwd(), client: existingClient, timeout = 600000, model, size, quality, output, codexPath } = opts;
  const ownClient = !existingClient;
  let cl = existingClient;

  const result = { text: "", threadId: null, turnId: null, usage: null, savedPaths: [] };

  try {
    if (ownClient) {
      cl = new CodexAppServerClient({ codexPath, timeout });
      await cl.start();
    } else {
      clearClientNotifications(cl);
    }

    const turnDone = new Promise((resolve) => {
      cl.onNotification("turn/completed", (params) => {
        result.usage = params?.usage || null;
        resolve();
      });
    });

    cl.onNotification("thread/started", (params) => {
      result.threadId = params.thread?.id;
    });

    cl.onNotification("item/completed", (params) => {
      const item = params.item || {};
      const text = extractItemText(item);
      if (text) {
        result.text += text;
        result.savedPaths.push(...extractFilePaths(text, cwd));
      }
      if (item.usage && !result.usage) result.usage = item.usage;
    });

    const threadResp = await cl.send("thread/start", { cwd });
    const threadId = threadResp.thread?.id || threadResp.id;

    const instruction = [
      "Use the imagegen skill to generate an image.",
      "",
      `Generate an image: ${prompt}`,
      size ? `Size: ${size}` : "",
      quality === "hd" ? "Use HD quality." : "",
      output ? `Save to: ${output}` : "Save to the current directory.",
    ].filter(Boolean).join("\n");

    const turnParams = { threadId, input: [{ type: "text", text: instruction }] };
    if (model) turnParams.model = model;

    const turn = await cl.send("turn/start", turnParams);
    result.turnId = turn.id;

    const timeoutP = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Timeout waiting for image generation")), 600000)
    );
    await Promise.race([turnDone, timeoutP]);
  } finally {
    clearClientNotifications(cl);
    if (ownClient) await cl.stop();
  }

  return {
    content: [{ type: "text", text: result.text.trim() || "(image generated)" }],
    savedPaths: [...new Set(result.savedPaths)],
    threadId: result.threadId,
    turnId: result.turnId,
    _usage: result.usage ? {
      input_tokens: result.usage.input_tokens || result.usage.prompt_tokens || 0,
      output_tokens: result.usage.output_tokens || result.usage.completion_tokens || 0,
    } : null,
  };
}

// ── App-server image editing ────────────────────────────────────────

export async function editImage(prompt, imagePath, opts = {}) {
  const cwd = opts.cwd || process.cwd();
  const absImage = path.resolve(cwd, imagePath);
  const { client: existingClient, timeout = 600000, model, output, codexPath } = opts;
  const ownClient = !existingClient;
  let cl = existingClient;

  const result = { text: "", threadId: null, turnId: null, usage: null, savedPaths: [] };

  try {
    if (ownClient) {
      cl = new CodexAppServerClient({ codexPath, timeout });
      await cl.start();
    } else {
      clearClientNotifications(cl);
    }

    const turnDone = new Promise((resolve) => {
      cl.onNotification("turn/completed", (params) => {
        result.usage = params?.usage || null;
        resolve();
      });
    });

    cl.onNotification("thread/started", (params) => {
      result.threadId = params.thread?.id;
    });

    cl.onNotification("item/completed", (params) => {
      const item = params.item || {};
      const text = extractItemText(item);
      if (text) {
        result.text += text;
        result.savedPaths.push(...extractFilePaths(text, cwd));
      }
      if (item.usage && !result.usage) result.usage = item.usage;
    });

    const threadResp = await cl.send("thread/start", { cwd });
    const threadId = threadResp.thread?.id || threadResp.id;

    const instruction = [
      "Use the imagegen skill to edit the attached image.",
      `Edit this image: ${prompt}`,
      output ? `Save to: ${output}` : "Save to the current directory.",
    ].filter(Boolean).join("\n");

    const turnParams = {
      threadId,
      input: [
        { type: "text", text: "The attached image is the edit target. Preserve unrelated parts unless instructed otherwise." },
        { type: "localImage", path: absImage },
        { type: "text", text: instruction },
      ],
    };
    if (model) turnParams.model = model;

    const turn = await cl.send("turn/start", turnParams);
    result.turnId = turn.id;

    const timeoutP = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Timeout waiting for image edit")), 600000)
    );
    await Promise.race([turnDone, timeoutP]);
  } finally {
    clearClientNotifications(cl);
    if (ownClient) await cl.stop();
  }

  return {
    content: [{ type: "text", text: result.text.trim() || "(image edited)" }],
    savedPaths: [...new Set(result.savedPaths)],
    threadId: result.threadId,
    turnId: result.turnId,
    _usage: result.usage ? {
      input_tokens: result.usage.input_tokens || result.usage.prompt_tokens || 0,
      output_tokens: result.usage.output_tokens || result.usage.completion_tokens || 0,
    } : null,
  };
}

// ── Convenience wrappers ────────────────────────────────────────────

export function handleImageEdit(userPrompt, systemPrompt, opts = {}) {
  let imagePath, editPrompt;
  if (systemPrompt) {
    imagePath = systemPrompt;
    editPrompt = userPrompt;
  } else {
    const parts = userPrompt.trim().split(/\s+/);
    if (parts.length < 2)
      throw new Error("image-edit requires an image path and edit prompt");
    imagePath = parts[0];
    editPrompt = parts.slice(1).join(" ");
  }
  return editImage(editPrompt, imagePath, opts);
}

export function handleGenerateImage(userPrompt, opts = {}) {
  return generateImage(userPrompt, opts);
}

// ── Helpers ─────────────────────────────────────────────────────────

function clearClientNotifications(cl) {
  cl.clearNotifications("turn/completed");
  cl.clearNotifications("thread/started");
  cl.clearNotifications("item/completed");
}

function extractItemText(item) {
  if (item.text) return item.text;
  if (item.content) {
    if (typeof item.content === "string") return item.content;
    if (Array.isArray(item.content)) {
      return item.content
        .filter((b) => b.type === "text" || b.type === "output_text")
        .map((b) => b.text)
        .join("\n");
    }
  }
  return "";
}

function extractFilePaths(text, cwd) {
  const paths = [];
  // Markdown links: [name](<path>) or [name](path)
  const mdRe = /\[([^\]]*)\]\(<?([^)>]+)>?\)/g;
  let m;
  while ((m = mdRe.exec(text)) !== null) {
    const p = m[2];
    if (isImageExt(p)) paths.push(path.resolve(cwd, p));
  }
  // Inline code spans with absolute paths
  const codeRe = /`([^`]+)`/g;
  while ((m = codeRe.exec(text)) !== null) {
    const p = m[1];
    if (isImageExt(p) && path.isAbsolute(p)) paths.push(p);
  }
  return paths;
}

function isImageExt(p) {
  return /\.(png|jpg|jpeg|gif|webp|bmp|svg)$/i.test(p);
}
