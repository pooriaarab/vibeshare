/**
 * bore — TCP tunnel to bore.pub.
 *
 *   bore local PORT --to bore.pub
 *   → "listening at bore.pub:<n>"  ⇒  http://bore.pub:<n>
 */
import { commandExists as defaultCommandExists } from '../detect.js';
import type { ProviderDeps, TunnelProvider, TunnelStartOpts } from '../provider.js';
import { startProcessTunnel } from '../process.js';

/**
 * Captures the `host:port` from bore's "listening at …" line.
 * mapUrl builds the public HTTP URL.
 */
export const BORE_URL_RE = /listening at\s+((?:bore\.pub|[a-zA-Z0-9.-]+):(\d+))/i;

export function createBoreProvider(deps: ProviderDeps = {}): TunnelProvider {
  const exists = deps.commandExists ?? defaultCommandExists;

  return {
    name: 'bore',

    async detect(): Promise<boolean> {
      return exists('bore');
    },

    async start(port: number, opts?: TunnelStartOpts) {
      const to = opts?.hostname ?? 'bore.pub';
      return startProcessTunnel({
        command: 'bore',
        args: ['local', String(port), '--to', to],
        urlRegex: BORE_URL_RE,
        mapUrl: (m) => `http://${m[1]}`,
        deps,
        opts,
      });
    },
  };
}
