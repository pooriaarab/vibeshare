/**
 * localtunnel via npx.
 *
 *   npx --yes localtunnel --port PORT
 *   → your url is: https://<sub>.loca.lt
 */
import { commandExists as defaultCommandExists } from '../detect.js';
import type { ProviderDeps, TunnelProvider, TunnelStartOpts } from '../provider.js';
import { startProcessTunnel } from '../process.js';

/** Matches localtunnel's "your url is:" announcement. */
export const LOCALTUNNEL_URL_RE =
  /your url is:\s*(https:\/\/[a-z0-9-]+\.loca\.lt)/i;

export function createLocaltunnelProvider(deps: ProviderDeps = {}): TunnelProvider {
  const exists = deps.commandExists ?? defaultCommandExists;

  return {
    name: 'localtunnel',

    async detect(): Promise<boolean> {
      // npx ships with npm/node — treat either as good enough.
      return (await exists('npx')) || (await exists('localtunnel'));
    },

    async start(port: number, opts?: TunnelStartOpts) {
      const args = ['--yes', 'localtunnel', '--port', String(port)];
      if (opts?.hostname) {
        args.push('--subdomain', opts.hostname);
      }

      return startProcessTunnel({
        command: 'npx',
        args,
        urlRegex: LOCALTUNNEL_URL_RE,
        mapUrl: (m) => m[1] ?? m[0],
        deps,
        opts,
      });
    },
  };
}
