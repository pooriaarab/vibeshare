/**
 * localhost.run — SSH reverse tunnel.
 *
 *   ssh -R 80:localhost:PORT -o StrictHostKeyChecking=accept-new localhost.run
 *   → https://<sub>.lhr.life
 */
import { commandExists as defaultCommandExists } from '../detect.js';
import type { ProviderDeps, TunnelProvider, TunnelStartOpts } from '../provider.js';
import { startProcessTunnel } from '../process.js';

/** Matches localhost.run's current public hostname scheme. */
export const LOCALHOST_RUN_URL_RE = /https:\/\/[a-z0-9-]+\.lhr\.life/i;

export function createLocalhostRunProvider(deps: ProviderDeps = {}): TunnelProvider {
  const exists = deps.commandExists ?? defaultCommandExists;

  return {
    name: 'localhost_run',

    async detect(): Promise<boolean> {
      return exists('ssh');
    },

    async start(port: number, opts?: TunnelStartOpts) {
      return startProcessTunnel({
        command: 'ssh',
        args: [
          '-R',
          `80:localhost:${port}`,
          '-o',
          'StrictHostKeyChecking=accept-new',
          '-o',
          'ExitOnForwardFailure=yes',
          'localhost.run',
        ],
        urlRegex: LOCALHOST_RUN_URL_RE,
        deps,
        opts,
      });
    },
  };
}
