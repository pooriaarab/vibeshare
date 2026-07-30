/**
 * getvibe — vibeshare's own tunnel endpoint (placeholder).
 *
 * No child process. Always detectable. Returns a deterministic getvibe.dev
 * URL so the rest of the stack can wire against a stable shape before the
 * production relay lands.
 */
import type { ProviderDeps, TunnelHandle, TunnelProvider, TunnelStartOpts } from '../provider.js';

const DEFAULT_BASE = 'https://getvibe.dev';

/** Regex documenting the public URL shape (used by tests / diagnostics). */
export const GETVIBE_URL_RE = /^https:\/\/getvibe\.dev\/t\/[A-Za-z0-9_-]+$/;

export function createGetvibeProvider(deps: ProviderDeps = {}): TunnelProvider {
  const base = (deps.getvibeBaseUrl ?? DEFAULT_BASE).replace(/\/$/, '');

  return {
    name: 'getvibe',

    async detect(): Promise<boolean> {
      return true;
    },

    async start(port: number, _opts?: TunnelStartOpts): Promise<TunnelHandle> {
      // Placeholder capability path — no network, no spawn.
      const url = `${base}/t/local-${port}`;
      return {
        url,
        async stop() {
          /* nothing to tear down */
        },
      };
    },
  };
}
