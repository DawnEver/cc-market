// A stand-in for `python -m ai_lab.call`: reads one request on stdin and answers per the
// request's provider name, so a test drives each branch of the protocol. It records the
// request and its argv to $FAKE_AI_LAB_RECORD when set.
import fs from "node:fs";

let input = "";
process.stdin.on("data", (d) => { input += d; });
process.stdin.on("end", () => {
  const req = JSON.parse(input);
  if (process.env.FAKE_AI_LAB_RECORD) fs.writeFileSync(process.env.FAKE_AI_LAB_RECORD, JSON.stringify({ argv: process.argv.slice(2), req }));
  const reply = (r) => process.stdout.write(JSON.stringify({ schema_version: 1, ok: false, kind: "", result: null, usage: null, key_slot: 0, error: "", ...r }) + "\n");
  switch (req.provider) {
    case "malformed": process.stderr.write("malformed request: missing field(s) ['schema']\n"); process.exit(2); break;
    case "nomodule": process.stderr.write("C:\py\python.exe: No module named ai_lab\n"); process.exit(1); break;
    case "hang": setInterval(() => {}, 1000); break;
    case "v2": process.stdout.write(JSON.stringify({ schema_version: 2, ok: true }) + "\n"); break;
    case "unclassified": reply({ error: "the vendor said no" }); break;
    default:
      if (req.provider.startsWith("kind-")) { reply({ kind: req.provider.slice(5), error: `classified ${req.provider.slice(5)}` }); break; }
      reply({ ok: true, result: { text: `echo: ${req.context[0].text}` }, usage: { input_tokens: 3, output_tokens: 5, cached_tokens: 0, reasoning_tokens: 0, cost_usd: null }, key_slot: 1 });
  }
});
