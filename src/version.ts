/**
 * Package version — always derived from package.json so it can never drift
 * from what npm publishes. tsup also bakes the same value in via `define`
 * (see tsup.config.ts) so the built CLI still reports correctly if the
 * package.json layout ever changes under a bundler.
 */
import { createRequire } from 'node:module';

/** Build-time inject from tsup `define` (string literal). Absent under vitest. */
declare const __VIBESHARE_VERSION__: string | undefined;

function readPackageVersion(): string {
  // createRequire works from both src/ (tests) and dist/ (built CLI):
  //   src/version.ts  → ../package.json
  //   dist/version.js → ../package.json  (npm always ships package.json)
  try {
    const require = createRequire(import.meta.url);
    const pkg = require('../package.json') as { version?: unknown };
    if (typeof pkg.version === 'string' && pkg.version.length > 0) return pkg.version;
  } catch {
    /* fall through */
  }
  return '0.0.0-dev';
}

/**
 * The vibeshare version string (semver). Equal to package.json's `"version"`.
 */
export const VERSION: string =
  typeof __VIBESHARE_VERSION__ !== 'undefined' ? __VIBESHARE_VERSION__ : readPackageVersion();
