import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    cli: 'src/cli.ts',
    mcp: 'src/mcp.ts',
  },
  format: ['esm'],
  dts: true,
  clean: true,
  target: 'node18',
  outDir: 'dist',
  sourcemap: false,
  // The CLI and MCP entries carry a `#!/usr/bin/env node` shebang; esbuild
  // preserves it as the first line of the emitted file.
});
