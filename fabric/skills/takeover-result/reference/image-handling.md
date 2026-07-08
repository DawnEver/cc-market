# Image Handoff

When the takeover task references image files (paths ending in .png/.jpg/.jpeg/.gif/.webp/.bmp):

## Step 1 — Locate
Use Glob or Read to verify each image file exists and is readable.

## Step 2 — Pass paths to call
Pass images as the `images` parameter with ONLY `path` and `media_type` — the MCP server
reads files and base64-encodes them directly. Do NOT base64-encode yourself; do NOT read
image file contents.

```json
[
  {"path": "C:/absolute/path/to/image.png", "media_type": "image/png"}
]
```

Derive `media_type` from the file extension: `.png` → `image/png`, `.jpg`/`.jpeg` →
`image/jpeg`, `.gif` → `image/gif`, `.webp` → `image/webp`, `.bmp` → `image/bmp`.

## Why paths, not data
The MCP server is a Node.js process with direct filesystem access. It reads images via
`readFileSync` — no size limits, no base64 shuttling through tool call arguments. The
agent never touches the image bytes.

## Resize (only when explicitly asked)
Do NOT resize unless the user instructs to ("make it smaller", "compress", "resize").
The MCP server passes original images directly via stdin pipe (no command-line length
limit), and vision models charge tokens by pixel dimensions, not file size.
