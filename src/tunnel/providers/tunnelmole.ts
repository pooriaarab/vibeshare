/**
 * tunnelmole via npx.
 *
 *   npx --yes tunnelmole PORT
 *   → https://<sub>.tunnelmole.net
 */
import { commandExists as defaultCommandExists } from '../detect.js';
import type { ProviderDeps, TunnelProvider, TunnelStartOpts } from '../provider.js';
import { startProcessTunnel } from '../process.js';

/** Matches tunnelmole public HTTPS URLs. */
export const TUNNELMOLE_URL_RE = /https:\/\/[a-z0-9-]+\.tunnelmole\.net/i;

export function createTunnelmoleProvider(deps: ProviderDeps = {}): TunnelProvider {
  const exists = deps.commandExists ?? defaultCommandExists;

  return {
    name: 'tunnelmole',

    async detect(): Promise<boolean> {
      return (await exists('npx')) || (await exists('tunnelmole')) || (await exists('tmole'));
    },

    async start(port: number, opts?: TunnelStartOpts) {
      return startProcessTunnel({
        command: 'npx',
        args: ['--yes', 'tunnelmole', String(port)],
        urlRegex: TUNNELMOLE_URL_RE,
        deps,
        opts,
      });
    },
  };
}
