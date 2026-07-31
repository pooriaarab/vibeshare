/**
 * cloudflared quick tunnel (and optional named-hostname variant).
 *
 *   cloudflared tunnel --url http://localhost:PORT
 *   → https://<sub>.trycloudflare.com
 */
import { commandExists as defaultCommandExists } from '../detect.js';
import type { ProviderDeps, TunnelProvider, TunnelStartOpts } from '../provider.js';
import { startProcessTunnel } from '../process.js';

/** Matches Cloudflare quick-tunnel hostnames. */
export const CLOUDFLARED_URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

export function createCloudflaredProvider(deps: ProviderDeps = {}): TunnelProvider {
  const exists = deps.commandExists ?? defaultCommandExists;

  return {
    name: 'cloudflared',

    async detect(): Promise<boolean> {
      return exists('cloudflared');
    },

    async start(port: number, opts?: TunnelStartOpts) {
      const args = ['tunnel'];
      if (opts?.hostname) {
        // Named-tunnel / custom hostname form.
        args.push('--hostname', opts.hostname);
      }
      args.push('--url', `http://localhost:${port}`);

      return startProcessTunnel({
        command: 'cloudflared',
        args,
        urlRegex: CLOUDFLARED_URL_RE,
        deps,
        opts,
      });
    },
  };
}
