/**
 * Tailscale Funnel.
 *
 *   tailscale funnel PORT
 *   → https://<host>.ts.net
 */
import { commandExists as defaultCommandExists } from '../detect.js';
import type { ProviderDeps, TunnelProvider, TunnelStartOpts } from '../provider.js';
import { startProcessTunnel } from '../process.js';

/** Matches Tailscale Funnel / Serve public hostnames. */
export const TAILSCALE_URL_RE = /https:\/\/[a-zA-Z0-9._-]+\.ts\.net/i;

export function createTailscaleProvider(deps: ProviderDeps = {}): TunnelProvider {
  const exists = deps.commandExists ?? defaultCommandExists;

  return {
    name: 'tailscale',

    async detect(): Promise<boolean> {
      return exists('tailscale');
    },

    async start(port: number, opts?: TunnelStartOpts) {
      return startProcessTunnel({
        command: 'tailscale',
        args: ['funnel', String(port)],
        urlRegex: TAILSCALE_URL_RE,
        deps,
        opts,
      });
    },
  };
}
