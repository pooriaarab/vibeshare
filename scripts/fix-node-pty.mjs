#!/usr/bin/env node
/**
 * node-pty ships platform spawn-helper binaries without the executable bit
 * under some npm pack/extract paths. posix_spawnp fails without +x.
 */
import { chmodSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let root;
try {
  root = dirname(require.resolve('node-pty/package.json'));
} catch {
  process.exit(0);
}
const prebuilds = join(root, 'prebuilds');
if (!existsSync(prebuilds)) process.exit(0);
for (const plat of readdirSync(prebuilds)) {
  const helper = join(prebuilds, plat, 'spawn-helper');
  if (!existsSync(helper)) continue;
  try {
    const mode = statSync(helper).mode;
    chmodSync(helper, mode | 0o111);
  } catch {
    /* best effort */
  }
}
