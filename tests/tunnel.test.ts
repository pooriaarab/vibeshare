/**
 * TunnelProvider registry — pure unit tests.
 *
 * No real network, no real tunnel binaries. A fake spawn factory emits the
 * canned log lines each provider would print in production, and we assert
 * the scraped public URL matches.
 */
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BORE_URL_RE,
  CLOUDFLARED_URL_RE,
  createBoreProvider,
  createCloudflaredProvider,
  createDefaultProviders,
  createFrpProvider,
  createGetvibeProvider,
  createLocalhostRunProvider,
  createLocaltunnelProvider,
  createNgrokProvider,
  createPinggyProvider,
  createServeoProvider,
  createTailscaleProvider,
  createTunnelmoleProvider,
  createTunnelRegistry,
  createZrokProvider,
  DEFAULT_PROVIDER_ORDER,
  FRP_URL_RE,
  GETVIBE_URL_RE,
  LOCALHOST_RUN_URL_RE,
  LOCALTUNNEL_URL_RE,
  NGROK_URL_RE,
  PINGGY_URL_RE,
  SERVEO_URL_RE,
  TAILSCALE_URL_RE,
  TunnelRegistry,
  TUNNELMOLE_URL_RE,
  ZROK_URL_RE,
  type SpawnImpl,
  type TunnelChildProcess,
  type TunnelProvider,
} from '../src/tunnel/index.js';

// ── fake child process ────────────────────────────────────────────────────

class FakeChild extends EventEmitter implements TunnelChildProcess {
  readonly pid = 4242;
  killed = false;
  readonly stdout: Readable;
  readonly stderr: Readable;
  private readonly outPush: (chunk: string | null) => void;
  private readonly errPush: (chunk: string | null) => void;
  killSignal: NodeJS.Signals | number | undefined;

  constructor() {
    super();
    // Pull-driven Readables we push strings into from the test.
    const self = this;
    this.stdout = new Readable({
      read() {
        /* pull-driven; we push from outside */
      },
    });
    this.stderr = new Readable({
      read() {
        /* pull-driven */
      },
    });
    this.outPush = (c) => {
      if (c === null) self.stdout.push(null);
      else self.stdout.push(c);
    };
    this.errPush = (c) => {
      if (c === null) self.stderr.push(null);
      else self.stderr.push(c);
    };
  }

  emitStdout(text: string): void {
    this.outPush(text);
  }

  emitStderr(text: string): void {
    this.errPush(text);
  }

  end(): void {
    this.outPush(null);
    this.errPush(null);
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    this.killed = true;
    this.killSignal = signal;
    // Simulate async exit after kill.
    queueMicrotask(() => this.emit('exit', null, typeof signal === 'string' ? signal : 'SIGTERM'));
    return true;
  }
}

interface SpawnCall {
  command: string;
  args: readonly string[];
  child: FakeChild;
}

function makeSpawner(script: (call: SpawnCall) => void): {
  spawn: SpawnImpl;
  calls: SpawnCall[];
} {
  const calls: SpawnCall[] = [];
  const spawn: SpawnImpl = (command, args) => {
    const child = new FakeChild();
    const call: SpawnCall = { command, args: [...args], child };
    calls.push(call);
    // Defer so start() can attach listeners first.
    queueMicrotask(() => script(call));
    return child;
  };
  return { spawn, calls };
}

const always: (name: string) => (cmd: string) => Promise<boolean> =
  (name) => async (cmd) => cmd === name || cmd === 'npx' || cmd === 'ssh';

// ── provider URL scrape matrix ────────────────────────────────────────────

interface Case {
  name: string;
  create: (deps: { spawn: SpawnImpl; commandExists: (c: string) => Promise<boolean> }) => TunnelProvider;
  command: string;
  /** Real-world log snippet(s) the CLI would print. */
  log: { stream: 'stdout' | 'stderr'; text: string };
  expectedUrl: string;
  expectedArgs?: (port: number) => string[];
  port?: number;
  startOpts?: { hostname?: string; serverAddr?: string; timeoutMs?: number };
  env?: NodeJS.ProcessEnv;
  detectCmd?: string;
}

const PORT = 8765;

const CASES: Case[] = [
  {
    name: 'cloudflared',
    create: (d) => createCloudflaredProvider(d),
    command: 'cloudflared',
    log: {
      stream: 'stderr',
      text: '2024-01-01 INF |  https://random-words-1a2b.trycloudflare.com\n',
    },
    expectedUrl: 'https://random-words-1a2b.trycloudflare.com',
    expectedArgs: (p) => ['tunnel', '--url', `http://localhost:${p}`],
  },
  {
    name: 'ngrok',
    create: (d) => createNgrokProvider(d),
    command: 'ngrok',
    log: {
      stream: 'stdout',
      text: 't=2024-01-01 lvl=info msg="started tunnel" obj=tunnels name=command_line url=https://abc123.ngrok-free.app\n',
    },
    expectedUrl: 'https://abc123.ngrok-free.app',
    expectedArgs: (p) => ['http', String(p), '--log', 'stdout'],
  },
  {
    name: 'tailscale',
    create: (d) => createTailscaleProvider(d),
    command: 'tailscale',
    log: {
      stream: 'stdout',
      text: 'Available on the internet:\n\nhttps://mybox.tailnet-name.ts.net/\n\nPress Ctrl+C to exit.\n',
    },
    expectedUrl: 'https://mybox.tailnet-name.ts.net',
    expectedArgs: (p) => ['funnel', String(p)],
  },
  {
    name: 'localhost_run',
    create: (d) => createLocalhostRunProvider(d),
    command: 'ssh',
    log: {
      stream: 'stdout',
      text: 'authenticated\nhttps://funny-name.lhr.life tunneled with tls termination\n',
    },
    expectedUrl: 'https://funny-name.lhr.life',
    expectedArgs: (p) => [
      '-R',
      `80:localhost:${p}`,
      '-o',
      'StrictHostKeyChecking=accept-new',
      '-o',
      'ExitOnForwardFailure=yes',
      'localhost.run',
    ],
    detectCmd: 'ssh',
  },
  {
    name: 'serveo',
    create: (d) => createServeoProvider(d),
    command: 'ssh',
    log: {
      stream: 'stdout',
      text: 'Forwarding HTTP traffic from https://xyz.serveo.net\n',
    },
    expectedUrl: 'https://xyz.serveo.net',
    expectedArgs: (p) => [
      '-R',
      `80:localhost:${p}`,
      '-o',
      'ExitOnForwardFailure=yes',
      'serveo.net',
    ],
    detectCmd: 'ssh',
  },
  {
    name: 'pinggy',
    create: (d) => createPinggyProvider(d),
    command: 'ssh',
    log: {
      stream: 'stdout',
      text: 'Allocated http url: https://mysub.a.pinggy.online\n',
    },
    expectedUrl: 'https://mysub.a.pinggy.online',
    expectedArgs: (p) => [
      '-p',
      '443',
      '-R',
      `0:localhost:${p}`,
      '-o',
      'StrictHostKeyChecking=accept-new',
      '-o',
      'ExitOnForwardFailure=yes',
      'a.pinggy.io',
    ],
    detectCmd: 'ssh',
  },
  {
    name: 'bore',
    create: (d) => createBoreProvider(d),
    command: 'bore',
    log: {
      stream: 'stderr',
      text: 'listening at bore.pub:41234\n',
    },
    expectedUrl: 'http://bore.pub:41234',
    expectedArgs: (p) => ['local', String(p), '--to', 'bore.pub'],
  },
  {
    name: 'localtunnel',
    create: (d) => createLocaltunnelProvider(d),
    command: 'npx',
    log: {
      stream: 'stdout',
      text: 'your url is: https://giant-horse-42.loca.lt\n',
    },
    expectedUrl: 'https://giant-horse-42.loca.lt',
    expectedArgs: (p) => ['--yes', 'localtunnel', '--port', String(p)],
    detectCmd: 'npx',
  },
  {
    name: 'tunnelmole',
    create: (d) => createTunnelmoleProvider(d),
    command: 'npx',
    log: {
      stream: 'stdout',
      text: 'Your tunnelmole URL is: https://happy-fox-99.tunnelmole.net\n',
    },
    expectedUrl: 'https://happy-fox-99.tunnelmole.net',
    expectedArgs: (p) => ['--yes', 'tunnelmole', String(p)],
    detectCmd: 'npx',
  },
  {
    name: 'zrok',
    create: (d) => createZrokProvider(d),
    command: 'zrok',
    log: {
      stream: 'stdout',
      text: '╭─────────────────────────────────────────────────────────╮\n│ https://abcd1234.share.zrok.io                          │\n╰─────────────────────────────────────────────────────────╯\n',
    },
    expectedUrl: 'https://abcd1234.share.zrok.io',
    expectedArgs: (p) => [
      'share',
      'public',
      '--backend-mode',
      'proxy',
      `http://localhost:${p}`,
    ],
  },
  {
    name: 'frp',
    create: (d) =>
      createFrpProvider({
        ...d,
        env: { FRP_SERVER_ADDR: 'frps.example.com:7000' },
      }),
    command: 'frpc',
    log: {
      stream: 'stdout',
      text: 'login to server success\nhttp proxy listen on http://frps.example.com:8080\n',
    },
    expectedUrl: 'http://frps.example.com:8080',
    expectedArgs: (p) => ['http', '-s', 'frps.example.com:7000', '-l', String(p)],
    env: { FRP_SERVER_ADDR: 'frps.example.com:7000' },
  },
];

describe('TunnelProvider URL scrape (mocked child)', () => {
  for (const c of CASES) {
    it(`${c.name} parses public URL from real log format`, async () => {
      const { spawn, calls } = makeSpawner((call) => {
        if (c.log.stream === 'stdout') call.child.emitStdout(c.log.text);
        else call.child.emitStderr(c.log.text);
      });
      const provider = c.create({
        spawn,
        commandExists: async (cmd) => cmd === (c.detectCmd ?? c.command) || cmd === c.command,
      });

      expect(provider.name).toBe(c.name);
      expect(await provider.detect()).toBe(true);

      const handle = await provider.start(c.port ?? PORT, c.startOpts);
      expect(handle.url).toBe(c.expectedUrl);

      expect(calls).toHaveLength(1);
      expect(calls[0]!.command).toBe(c.command);
      if (c.expectedArgs) {
        expect(calls[0]!.args).toEqual(c.expectedArgs(c.port ?? PORT));
      }

      await handle.stop();
      expect(calls[0]!.child.killed).toBe(true);
    });
  }

  it('getvibe is always available and returns a placeholder URL (no spawn)', async () => {
    const spawn = vi.fn() as unknown as SpawnImpl;
    const p = createGetvibeProvider({ spawn, getvibeBaseUrl: 'https://getvibe.dev' });
    expect(p.name).toBe('getvibe');
    expect(await p.detect()).toBe(true);
    const handle = await p.start(3000);
    expect(handle.url).toBe('https://getvibe.dev/t/local-3000');
    expect(GETVIBE_URL_RE.test(handle.url)).toBe(true);
    expect(spawn).not.toHaveBeenCalled();
    await handle.stop();
  });

  it('cloudflared named-hostname variant passes --hostname', async () => {
    const { spawn, calls } = makeSpawner((call) => {
      call.child.emitStderr('INF https://app.example.com via trycloudflare? no — https://x.trycloudflare.com\n');
    });
    const p = createCloudflaredProvider({
      spawn,
      commandExists: async () => true,
    });
    const handle = await p.start(PORT, { hostname: 'app.example.com' });
    expect(handle.url).toBe('https://x.trycloudflare.com');
    expect(calls[0]!.args).toEqual([
      'tunnel',
      '--hostname',
      'app.example.com',
      '--url',
      `http://localhost:${PORT}`,
    ]);
    await handle.stop();
  });
});

describe('start timeout / stop / abort', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('rejects when no URL line appears before timeout', async () => {
    const { spawn, calls } = makeSpawner((call) => {
      call.child.emitStdout('still starting…\n');
    });
    const p = createNgrokProvider({ spawn, commandExists: async () => true });

    await expect(p.start(PORT, { timeoutMs: 40 })).rejects.toThrow(/timed out/i);
    expect(calls[0]!.child.killed).toBe(true);
  });

  it('rejects when the child exits before a URL appears', async () => {
    const { spawn } = makeSpawner((call) => {
      call.child.emitStdout('fatal: not logged in\n');
      call.child.emit('exit', 1, null);
    });
    const p = createNgrokProvider({ spawn, commandExists: async () => true });
    await expect(p.start(PORT, { timeoutMs: 2000 })).rejects.toThrow(/exited before/i);
  });

  it('stop() kills the child of a live handle', async () => {
    const { spawn, calls } = makeSpawner((call) => {
      call.child.emitStdout('url=https://live.ngrok-free.app\n');
    });
    const p = createNgrokProvider({ spawn, commandExists: async () => true });
    const handle = await p.start(PORT);
    expect(handle.url).toBe('https://live.ngrok-free.app');
    expect(calls[0]!.child.killed).toBe(false);
    await handle.stop();
    expect(calls[0]!.child.killed).toBe(true);
    expect(calls[0]!.child.killSignal).toBe('SIGTERM');
  });

  it('abort signal cancels an in-flight start', async () => {
    const { spawn, calls } = makeSpawner((_call) => {
      // never emit a URL
    });
    const p = createCloudflaredProvider({ spawn, commandExists: async () => true });
    const ac = new AbortController();
    const pending = p.start(PORT, { signal: ac.signal, timeoutMs: 5000 });
    // Let listeners attach, then abort.
    await Promise.resolve();
    ac.abort();
    await expect(pending).rejects.toThrow(/abort/i);
    expect(calls[0]!.child.killed).toBe(true);
  });

  it('frp start throws without a server address', async () => {
    const p = createFrpProvider({
      spawn: vi.fn() as unknown as SpawnImpl,
      commandExists: async () => true,
      env: {},
    });
    // detect is false without FRP_SERVER_ADDR
    expect(await p.detect()).toBe(false);
    await expect(p.start(PORT)).rejects.toThrow(/server address/i);
  });

  it('frp detect requires both frpc and a server config', async () => {
    const withoutServer = createFrpProvider({
      commandExists: async (c) => c === 'frpc',
      env: {},
    });
    expect(await withoutServer.detect()).toBe(false);

    const withoutBinary = createFrpProvider({
      commandExists: async () => false,
      env: { FRP_SERVER_ADDR: 'x:7000' },
    });
    expect(await withoutBinary.detect()).toBe(false);

    const ok = createFrpProvider({
      commandExists: async (c) => c === 'frpc',
      env: { FRP_SERVER_ADDR: 'x:7000' },
    });
    expect(await ok.detect()).toBe(true);
  });
});

describe('TunnelRegistry', () => {
  it('lists all default providers in cascade order', () => {
    const reg = createTunnelRegistry({
      commandExists: async () => false,
      env: {},
    });
    const names = reg.list().map((p) => p.name);
    expect(names).toEqual([...DEFAULT_PROVIDER_ORDER]);
    expect(names).toHaveLength(12);
  });

  it('cascade resolve() picks the first detect()===true provider', async () => {
    // Only ngrok and serveo claim to be installed; cascade should prefer
    // ngrok (earlier) over serveo.
    const installed = new Set(['ngrok', 'ssh']);
    const reg = createTunnelRegistry({
      commandExists: async (c) => installed.has(c),
      env: {},
      // Keep getvibe out of the way by swapping in an empty list and
      // rebuilding — we construct providers manually for this case.
    });

    // getvibe always detects — so default resolve always hits it.
    // Build a registry without getvibe to exercise the cascade path cleanly.
    const providers = createDefaultProviders({
      commandExists: async (c) => installed.has(c),
      env: {},
    }).filter((p) => p.name !== 'getvibe');
    const bare = new TunnelRegistry(providers);

    const picked = await bare.resolve();
    expect(picked.name).toBe('ngrok');

    const avail = await bare.available();
    expect(avail.map((p) => p.name).sort()).toEqual(
      ['localhost_run', 'ngrok', 'pinggy', 'serveo'].sort(),
    );
  });

  it('resolve() with no available providers throws', async () => {
    const bare = new TunnelRegistry([
      {
        name: 'none',
        detect: async () => false,
        start: async () => {
          throw new Error('nope');
        },
      },
    ]);
    await expect(bare.resolve()).rejects.toThrow(/no tunnel provider available/i);
  });

  it("resolve('ngrok') throws if ngrok is undetected", async () => {
    const reg = createTunnelRegistry({
      commandExists: async () => false,
      env: {},
    });
    await expect(reg.resolve('ngrok')).rejects.toThrow(/not available/i);
  });

  it("resolve('ngrok') returns ngrok when detected", async () => {
    const reg = createTunnelRegistry({
      commandExists: async (c) => c === 'ngrok',
      env: {},
    });
    const p = await reg.resolve('ngrok');
    expect(p.name).toBe('ngrok');
  });

  it('resolve(unknown) throws with known list', async () => {
    const reg = createTunnelRegistry({ commandExists: async () => true, env: {} });
    await expect(reg.resolve('not-a-real-tunnel')).rejects.toThrow(/unknown tunnel provider/i);
  });

  it('default resolve() returns getvibe (always detectable)', async () => {
    const reg = createTunnelRegistry({
      commandExists: async () => false,
      env: {},
    });
    const p = await reg.resolve();
    expect(p.name).toBe('getvibe');
  });

  it('rejects duplicate provider names', () => {
    const a = createGetvibeProvider();
    expect(() => new TunnelRegistry([a, a])).toThrow(/duplicate/i);
  });
});

describe('exported URL regexes match sample lines', () => {
  const samples: Array<[RegExp, string, string?]> = [
    [CLOUDFLARED_URL_RE, 'https://foo-bar.trycloudflare.com'],
    [NGROK_URL_RE, 'url=https://x.ngrok-free.app', 'https://x.ngrok-free.app'],
    [TAILSCALE_URL_RE, 'https://n.ts.net'],
    [LOCALHOST_RUN_URL_RE, 'https://a.lhr.life'],
    [SERVEO_URL_RE, 'https://a.serveo.net'],
    [PINGGY_URL_RE, 'https://x.a.pinggy.online'],
    [BORE_URL_RE, 'listening at bore.pub:1234'],
    [LOCALTUNNEL_URL_RE, 'your url is: https://z.loca.lt', 'https://z.loca.lt'],
    [TUNNELMOLE_URL_RE, 'https://z.tunnelmole.net'],
    [ZROK_URL_RE, 'https://z.share.zrok.io'],
    [FRP_URL_RE, 'http://s.example:8080'],
    [GETVIBE_URL_RE, 'https://getvibe.dev/t/local-1'],
  ];

  for (const [re, line] of samples) {
    it(`${re} ⊨ ${line}`, () => {
      re.lastIndex = 0;
      expect(re.test(line)).toBe(true);
    });
  }
});
