/**
 * zrok public share (proxy backend).
 *
 *   zrok share public --backend-mode proxy http://localhost:PORT
 *   → https://<sub>.share.zrok.io
 */
import { commandExists as defaultCommandExists } from '../detect.js';
import type { ProviderDeps, TunnelProvider, TunnelStartOpts } from '../provider.js';
import { startProcessTunnel } from '../process.js';

/** Matches zrok public share HTTPS URLs. */
export const ZROK_URL_RE =
  /https:\/\/[a-zA-Z0-9.-]+\.(?:share\.)?zrok\.io/i;

export function createZrokProvider(deps: ProviderDeps = {}): TunnelProvider {
  const exists = deps.commandExists ?? defaultCommandExists;

  return {
    name: 'zrok',

    async detect(): Promise<boolean> {
      return exists('zrok');
    },

    async start(port: number, opts?: TunnelStartOpts) {
      return startProcessTunnel({
        command: 'zrok',
        args: [
          'share',
          'public',
          '--backend-mode',
          'proxy',
          `http://localhost:${port}`,
        ],
        urlRegex: ZROK_URL_RE,
        deps,
        opts,
      });
    },
  };
}
