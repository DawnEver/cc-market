// Auto-push encrypted daily snapshot at session end. Non-blocking — always exit 0.
import { hasKey } from '../scripts/crypto.mjs';

async function main() {
  // Only proceed if sync is set up (key exists)
  if (!hasKey()) return;

  try {
    const syncUrl = new URL('../scripts/sync.mjs', import.meta.url).href;
    const { pushSnapshot } = await import(syncUrl);
    await pushSnapshot();
  } catch {}
}

await main();
