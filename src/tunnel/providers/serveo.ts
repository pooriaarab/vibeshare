/**
 * Serveo — SSH reverse tunnel.
 *
 *   ssh -R 80:localhost:PORT serveo.net
 *   → https://<sub>.serveo.net
 */
import { commandExists as defaultCommandExists } from '../detect.js';
import type { ProviderDeps, TunnelProvider, TunnelStartOpts } from '../provider.js';
import { startProcessTunnel } from '../process.js';

/** Matches Serveo forwarded HTTPS URLs. */
export const SERVEO_URL_RE = /https:\/\/[a-z0-9-]+\.serveo\.net/i;

export function createServeoProvider(deps: ProviderDeps = {}): TunnelProvider {
  const exists = deps.commandExists ?? defaultCommandExists;

  return {
    name: 'serveo',

    async detect(): Promise<boolean> {
      return exists('ssh');
    },

    async start(port: number, opts?: TunnelStartOpts) {
      const args = ['-R', `80:localhost:${port}`, '-o', 'ExitOnForwardFailure=yes'];
      if (opts?.hostname) {
        // Request a specific subdomain when Serveo allows it.
        args[1] = `${opts.hostname}:80:localhost:${port}`;
      }
      args.push('serveo.net');

      return startProcessTunnel({
        command: 'ssh',
        args,
        urlRegex: SERVEO_URL_RE,
        deps,
        opts,
      });
    },
  };
}
