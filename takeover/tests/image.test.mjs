import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { generateImage, editImage } from "../scripts/codex/image.mjs";

describe("generateImage", () => {
  test("rejects when codex binary not found", async () => {
    await assert.rejects(
      generateImage("a sunset", { codexPath: "/nonexistent/codex", cwd: process.cwd() }),
      /ENOENT|not found|spawn/
    );
  });
});

describe("editImage", () => {
  test("rejects when codex binary not found", async () => {
    await assert.rejects(
      editImage("make it brighter", "photo.png", { codexPath: "/nonexistent/codex", cwd: process.cwd() }),
      /ENOENT|not found|spawn/
    );
  });
});
