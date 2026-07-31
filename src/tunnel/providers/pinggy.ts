/**
 * Pinggy — SSH reverse tunnel over 443.
 *
 *   ssh -p 443 -R0:localhost:PORT -o StrictHostKeyChecking=accept-new a.pinggy.io
 *   → https://<sub>.a.pinggy.online  (or *.pinggy.io)
 */
import { commandExists as defaultCommandExists } from '../detect.js';
import type { ProviderDeps, TunnelProvider, TunnelStartOpts } from '../provider.js';
import { startProcessTunnel } from '../process.js';

/** Matches Pinggy public HTTPS URLs. */
export const PINGGY_URL_RE =
  /https:\/\/[a-zA-Z0-9.-]+\.(?:a\.)?pinggy\.(?:online|io)/i;

export function createPinggyProvider(deps: ProviderDeps = {}): TunnelProvider {
  const exists = deps.commandExists ?? defaultCommandExists;

  return {
    name: 'pinggy',

    async detect(): Promise<boolean> {
      return exists('ssh');
    },

    async start(port: number, opts?: TunnelStartOpts) {
      return startProcessTunnel({
        command: 'ssh',
        args: [
          '-p',
          '443',
          '-R',
          `0:localhost:${port}`,
          '-o',
          'StrictHostKeyChecking=accept-new',
          '-o',
          'ExitOnForwardFailure=yes',
          'a.pinggy.io',
        ],
        urlRegex: PINGGY_URL_RE,
        deps,
        opts,
      });
    },
  };
}
