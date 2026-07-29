#!/usr/bin/env node
/**
 * Dedicated executable entry for the `vibeshare-mcp` / `vibeshare-live-mcp`
 * bins. It calls `startMcp` unconditionally rather than relying on an
 * `import.meta.url === argv[1]` main-check: tsup code-splits the multi-entry
 * build into shared chunks, so `dist/mcp.js` becomes a re-export barrel whose
 * guard never fires under an npx/global symlinked bin (silent exit 0). A tiny
 * dedicated entry sidesteps that entirely.
 */
import { startMcp } from './mcp.js';

startMcp().catch((err: unknown) => {
  console.error('[vibeshare-mcp]', err);
  process.exit(1);
});
