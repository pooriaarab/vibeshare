/**
 * frp (frpc) — self-hosted reverse proxy.
 *
 * Requires a user-provided server address (`opts.serverAddr`, `opts.hostname`,
 * or `FRP_SERVER_ADDR`). Without a configured server, `detect()` is false —
 * we never assume a public frp endpoint.
 *
 *   frpc http -s SERVER -l PORT
 *   → parse a mapped http(s):// URL from frpc output
 */
import { commandExists as defaultCommandExists } from '../detect.js';
import type { ProviderDeps, TunnelProvider, TunnelStartOpts } from '../provider.js';
import { startProcessTunnel } from '../process.js';

/**
 * Matches a public http(s) URL printed by frpc once the proxy is up.
 * (frpc versions vary; tests feed a canned line containing the mapped URL.)
 */
export const FRP_URL_RE = /https?:\/\/[a-zA-Z0-9._-]+:\d+/i;

function resolveServerAddr(
  opts: TunnelStartOpts | undefined,
  env: NodeJS.ProcessEnv,
): string | undefined {
  return opts?.serverAddr ?? opts?.hostname ?? env.FRP_SERVER_ADDR ?? undefined;
}

export function createFrpProvider(deps: ProviderDeps = {}): TunnelProvider {
  const exists = deps.commandExists ?? defaultCommandExists;
  const env = deps.env ?? process.env;

  return {
    name: 'frp',

    async detect(): Promise<boolean> {
      if (!(await exists('frpc'))) return false;
      // No config / server → unusable.
      return Boolean(env.FRP_SERVER_ADDR || env.FRP_CONFIG);
    },

    async start(port: number, opts?: TunnelStartOpts) {
      const server = resolveServerAddr(opts, env);
      if (!server) {
        throw new Error(
          'frp requires a server address (TunnelStartOpts.serverAddr / hostname, or FRP_SERVER_ADDR)',
        );
      }

      // Prefer an explicit config file when the user set FRP_CONFIG.
      const configPath = env.FRP_CONFIG;
      const args = configPath
        ? ['-c', configPath]
        : ['http', '-s', server, '-l', String(port)];

      return startProcessTunnel({
        command: 'frpc',
        args,
        urlRegex: FRP_URL_RE,
        deps,
        opts,
      });
    },
  };
}
