/**
 * ngrok HTTP tunnel (v3 log-stdout format).
 *
 *   ngrok http PORT --log stdout
 *   → url=https://<sub>.ngrok-free.app
 */
import { commandExists as defaultCommandExists } from '../detect.js';
import type { ProviderDeps, TunnelProvider, TunnelStartOpts } from '../provider.js';
import { startProcessTunnel } from '../process.js';

/**
 * Captures the URL field from an ngrok v3 log line.
 * Accepts ngrok-free.app, ngrok.io, and ngrok.app hostnames.
 */
export const NGROK_URL_RE =
  /\burl=(https:\/\/[a-z0-9-]+\.(?:ngrok-free\.app|ngrok\.io|ngrok\.app))/i;

export function createNgrokProvider(deps: ProviderDeps = {}): TunnelProvider {
  const exists = deps.commandExists ?? defaultCommandExists;

  return {
    name: 'ngrok',

    async detect(): Promise<boolean> {
      return exists('ngrok');
    },

    async start(port: number, opts?: TunnelStartOpts) {
      const args = ['http', String(port), '--log', 'stdout'];
      if (opts?.hostname) {
        args.push('--hostname', opts.hostname);
      }

      return startProcessTunnel({
        command: 'ngrok',
        args,
        urlRegex: NGROK_URL_RE,
        mapUrl: (m) => m[1] ?? m[0],
        deps,
        opts,
      });
    },
  };
}
