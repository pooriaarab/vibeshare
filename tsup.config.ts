import { readFileSync } from 'node:fs';
import { defineConfig } from 'tsup';

const version = (JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  version: string;
}).version;

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    cli: 'src/cli.ts',
    mcp: 'src/mcp.ts',
    'mcp-bin': 'src/mcp-bin.ts',
  },
  format: ['esm'],
  dts: true,
  clean: true,
  target: 'node18',
  outDir: 'dist',
  sourcemap: false,
  // Bake package.json version into the bundle so --version can never drift.
  define: {
    __VIBESHARE_VERSION__: JSON.stringify(version),
  },
  // The CLI and MCP entries carry a `#!/usr/bin/env node` shebang; esbuild
  // preserves it as the first line of the emitted file.
});
