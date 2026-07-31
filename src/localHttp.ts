/**
 * LocalHttpTransport — the default ShareTransport. Real and complete:
 *
 *   GET  /s/:id              spectator web view (self-contained, no install)
 *   GET  /s/:id/meta         share metadata for the page
 *   POST /s/:id/join         become a viewer (passphrase checked here)
 *   GET  /s/:id/stream       SSE: replay + live feed, per-viewer events
 *   POST /s/:id/request-join spectator → pending collaborator (invite shares)
 *   POST /s/:id/leave        viewer leaves
 *
 * Host-only control (loopback + bearer host token — never exposed to viewers):
 *   GET  /control/shares · /control/viewers?share=<id>
 *   POST /control/approve · /control/deny · /control/kick · /control/stop
 *
 * There is deliberately NO route that writes to a feed. Read-only is enforced
 * by construction, not by the UI: the only publisher is the host process.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { networkInterfaces } from 'node:os';
import { timingSafeEqual } from 'node:crypto';
import { encryptFrame } from './e2e.js';
import type { SessionFeed } from './feed.js';
import type { ViewerRegistry } from './registry.js';
import { spectatorPage } from './spectatorPage.js';
import type { ShareTransport } from './transport.js';
import { ShareError, type Share, type Viewer } from './types.js';
import { newToken, verifyPassphrase } from './utils.js';

export interface LocalHttpTransportOptions {
  /** Bind address. Default 127.0.0.1 (loopback-only). Use 0.0.0.0 for LAN. */
  readonly host?: string;
  /** Port. Default 0 = ephemeral. */
  readonly port?: number;
  /**
   * Public base URL to print instead of `http://host:port` — the seam where
   * a future RelayTransport hands out `https://vibeshare.io` URLs. Routing
   * still happens locally.
   */
  readonly baseUrl?: string;
  /** Bearer token for the loopback control API. Generated when omitted. */
  readonly hostToken?: string;
  /**
   * Called when the control API asks to stop a share (e.g. `vibeshare stop`
   * from another process). When absent, the transport unserves + closes the
   * feed itself.
   */
  readonly onStopRequested?: (shareId: string) => void;
  /**
   * Opt-in end-to-end encryption for the spectator path (used by `--tunnel`).
   * When set:
   *   - every SSE event's data payload is `encryptFrame(key, …)` encoded as
   *     standard base64 (the tunnel provider sees only ciphertext);
   *   - the spectator page decrypts via WebCrypto using the key from the
   *     share URL `#fragment`.
   * When absent (the default pure-local loopback path) behaviour is
   * unchanged — plaintext SSE, existing tests stay green.
   */
  readonly e2e?: { readonly key: Buffer };
}

interface ShareContext {
  share: Share;
  feed: SessionFeed;
  viewers: ViewerRegistry;
  /** Open SSE connections, grouped by viewer id. */
  streams: Map<string, Set<ServerResponse>>;
}

const MAX_BODY = 64 * 1024;

export class LocalHttpTransport implements ShareTransport {
  readonly kind = 'local-http';
  readonly hostToken: string;

  readonly #host: string;
  readonly #port: number;
  readonly #baseUrl: string | undefined;
  readonly #onStop: ((shareId: string) => void) | undefined;
  readonly #e2eKey: Buffer | undefined;
  readonly #shares = new Map<string, ShareContext>();
  readonly #gone = new Set<string>();
  readonly #sockets = new Set<import('node:net').Socket>();
  #server: Server | null = null;
  #boundPort = 0;

  constructor(opts: LocalHttpTransportOptions = {}) {
    this.#host = opts.host ?? '127.0.0.1';
    this.#port = opts.port ?? 0;
    this.#baseUrl = opts.baseUrl;
    this.hostToken = opts.hostToken ?? newToken(24);
    this.#onStop = opts.onStopRequested;
    this.#e2eKey = opts.e2e?.key;
  }

  /** True when this transport encrypts SSE payloads end-to-end. */
  get e2eEnabled(): boolean {
    return this.#e2eKey !== undefined;
  }

  /** Bind the listener. Must be called before serve(). Idempotent. */
  async listen(): Promise<void> {
    if (this.#server) return;
    const server = createServer((req, res) => {
      void this.#route(req, res).catch((err: unknown) => this.#handleError(res, err));
    });
    server.on('connection', (socket) => {
      this.#sockets.add(socket);
      socket.on('close', () => this.#sockets.delete(socket));
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.#port, this.#host, () => resolve());
    });
    const addr = server.address();
    this.#boundPort = typeof addr === 'object' && addr !== null ? addr.port : this.#port;
    this.#server = server;
  }

  /** The port actually bound (useful with port 0). */
  get port(): number {
    return this.#boundPort;
  }

  async serve(share: Share, feed: SessionFeed, viewers: ViewerRegistry): Promise<string> {
    if (!this.#server) await this.listen();
    const ctx: ShareContext = { share, feed, viewers, streams: new Map() };
    this.#shares.set(share.id, ctx);
    this.#gone.delete(share.id);
    this.#wire(ctx);
    const base = `${this.#publicBase()}/s/${share.id}`;
    // Key rides ONLY in the URL fragment — never on the wire to the tunnel
    // provider (fragments are stripped by browsers before the request).
    if (this.#e2eKey) return `${base}#${this.#e2eKey.toString('base64url')}`;
    return base;
  }

  async unserve(shareId: string): Promise<void> {
    const ctx = this.#shares.get(shareId);
    if (!ctx) return;
    this.#shares.delete(shareId);
    this.#gone.add(shareId);
    this.#endAllStreams(ctx, ctx.share.state);
  }

  async close(): Promise<void> {
    for (const ctx of this.#shares.values()) this.#endAllStreams(ctx, ctx.share.state);
    this.#shares.clear();
    const server = this.#server;
    this.#server = null;
    if (!server) return;
    for (const socket of this.#sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  /** Number of shares currently served (diagnostics/tests). */
  get shareCount(): number {
    return this.#shares.size;
  }

  // ------------------------------------------------------------- wiring

  #wire(ctx: ShareContext): void {
    ctx.feed.on('close', () => {
      if (this.#shares.has(ctx.share.id)) {
        this.#shares.delete(ctx.share.id);
        this.#gone.add(ctx.share.id);
      }
      this.#endAllStreams(ctx, ctx.share.state);
    });

    const broadcastCount = () => this.#broadcastViewers(ctx);
    ctx.viewers.on('join', broadcastCount);
    ctx.viewers.on('leave', (v) => {
      this.#closeViewerStreams(ctx, v, null);
      broadcastCount();
    });
    ctx.viewers.on('kick', (v) => {
      this.#closeViewerStreams(ctx, v, 'kicked');
      broadcastCount();
    });
    ctx.viewers.on('approve', (v) => this.#sendToViewer(ctx, v, 'join-approved', {}));
    ctx.viewers.on('deny', (v) => this.#sendToViewer(ctx, v, 'join-denied', {}));
  }

  // ------------------------------------------------------------- routing

  async #route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    setSecurityHeaders(res);
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;

    if (path.startsWith('/control/')) {
      this.#routeControl(req, res, path, url);
      return;
    }

    const m = /^\/s\/([A-Za-z0-9_-]+)(?:\/(meta|stream|join|request-join|leave))?\/?$/.exec(path);
    if (!m) {
      sendJson(res, 404, { error: 'not found' });
      return;
    }
    const shareId = m[1]!;
    const action = m[2] ?? 'page';
    const ctx = this.#shares.get(shareId);
    if (!ctx) {
      const status = this.#gone.has(shareId) ? 410 : 404;
      if (action === 'page') {
        res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
        res.end('<!DOCTYPE html><title>vibeshare</title><body style="background:#0a0b0f;color:#edeef3;font-family:sans-serif;display:grid;place-items:center;min-height:100vh;margin:0"><p>This share has ended.</p></body>');
      } else {
        sendJson(res, status, { error: status === 410 ? 'share ended' : 'not found' });
      }
      return;
    }

    switch (action) {
      case 'page': {
        if (req.method !== 'GET') return void sendJson(res, 405, { error: 'method not allowed' });
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(spectatorPage(ctx.share, { e2e: this.#e2eKey !== undefined }));
        return;
      }
      case 'meta': {
        sendJson(res, 200, {
          id: ctx.share.id,
          name: ctx.share.name,
          access: ctx.share.access,
          state: ctx.share.state,
          requiresPassphrase: ctx.share.passphraseHash !== null,
          watching: streamCount(ctx),
        });
        return;
      }
      case 'join': {
        if (req.method !== 'POST') return void sendJson(res, 405, { error: 'method not allowed' });
        if (ctx.share.state !== 'live') throw new ShareError('not-live', 'share has ended');
        const body = await readJsonBody(req);
        if (ctx.share.passphraseHash !== null) {
          const pass = typeof body['pass'] === 'string' ? body['pass'] : '';
          if (pass.length === 0) throw new ShareError('passphrase-required', 'passphrase required');
          if (!verifyPassphrase(pass, ctx.share.passphraseHash)) {
            throw new ShareError('passphrase-invalid', 'wrong passphrase');
          }
        }
        const viewer = ctx.viewers.add(typeof body['name'] === 'string' ? body['name'] : undefined);
        sendJson(res, 200, { viewerId: viewer.id, token: viewer.token, role: viewer.role });
        return;
      }
      case 'stream': {
        if (req.method !== 'GET') return void sendJson(res, 405, { error: 'method not allowed' });
        const viewer = ctx.viewers.getByToken(url.searchParams.get('token') ?? '');
        if (!viewer) return void sendJson(res, 401, { error: 'unknown viewer token' });
        this.#openStream(ctx, viewer, res);
        return;
      }
      case 'request-join': {
        if (req.method !== 'POST') return void sendJson(res, 405, { error: 'method not allowed' });
        const body = await readJsonBody(req);
        const viewer = ctx.viewers.getByToken(typeof body['token'] === 'string' ? body['token'] : '');
        if (!viewer) return void sendJson(res, 401, { error: 'unknown viewer token' });
        ctx.viewers.requestJoin(viewer.id);
        sendJson(res, 202, { status: 'pending' });
        return;
      }
      case 'leave': {
        if (req.method !== 'POST') return void sendJson(res, 405, { error: 'method not allowed' });
        let token = url.searchParams.get('token') ?? '';
        if (token.length === 0) {
          const body = await readJsonBody(req);
          if (typeof body['token'] === 'string') token = body['token'];
        }
        const viewer = ctx.viewers.getByToken(token);
        if (viewer) ctx.viewers.leave(viewer.id);
        sendJson(res, 200, { ok: true });
        return;
      }
    }
  }

  #routeControl(req: IncomingMessage, res: ServerResponse, path: string, url: URL): void {
    if (!isLoopback(req.socket.remoteAddress) || !tokenMatches(req.headers.authorization, this.hostToken)) {
      sendJson(res, 401, { error: 'host-only control API' });
      return;
    }
    const respond = (fn: () => unknown): void => {
      try {
        sendJson(res, 200, fn() as Record<string, unknown>);
      } catch (err) {
        this.#handleError(res, err);
      }
    };

    void (async () => {
      switch (path) {
        case '/control/shares':
          respond(() => ({
            shares: [...this.#shares.values()].map((c) => ({
              id: c.share.id, name: c.share.name, access: c.share.access,
              state: c.share.state, watching: streamCount(c),
            })),
          }));
          return;
        case '/control/viewers': {
          const ctx = this.#mustCtx(url.searchParams.get('share') ?? '');
          respond(() => ({ viewers: ctx.viewers.list().map(publicViewer), watching: streamCount(ctx) }));
          return;
        }
        case '/control/approve':
        case '/control/deny':
        case '/control/kick': {
          if (req.method !== 'POST') return void sendJson(res, 405, { error: 'method not allowed' });
          const body = await readJsonBody(req);
          const ctx = this.#mustCtx(typeof body['share'] === 'string' ? body['share'] : '');
          const viewerId = typeof body['viewer'] === 'string' ? body['viewer'] : '';
          const action = path.slice('/control/'.length) as 'approve' | 'deny' | 'kick';
          respond(() => ({ viewer: publicViewer(ctx.viewers[action](viewerId)) }));
          return;
        }
        case '/control/stop': {
          if (req.method !== 'POST') return void sendJson(res, 405, { error: 'method not allowed' });
          const body = await readJsonBody(req);
          const shareId = typeof body['share'] === 'string' ? body['share'] : '';
          this.#mustCtx(shareId);
          sendJson(res, 200, { stopped: shareId });
          if (this.#onStop) this.#onStop(shareId);
          else {
            const ctx = this.#shares.get(shareId);
            if (ctx) {
              await this.unserve(shareId);
              ctx.feed.close();
            }
          }
          return;
        }
        default:
          sendJson(res, 404, { error: 'not found' });
      }
    })().catch((err: unknown) => this.#handleError(res, err));
  }

  #mustCtx(shareId: string): ShareContext {
    const ctx = this.#shares.get(shareId);
    if (!ctx) throw new ShareError('not-found', `no live share ${shareId}`);
    return ctx;
  }

  #handleError(res: ServerResponse, err: unknown): void {
    if (res.writableEnded) return;
    if (err instanceof ShareError) {
      const status =
        err.code === 'not-found' ? 404
        : err.code === 'not-live' ? 410
        : err.code === 'passphrase-required' || err.code === 'passphrase-invalid' || err.code === 'invite-disabled' ? 403
        : err.code === 'already-pending' || err.code === 'not-pending' ? 409
        : 400;
      sendJson(res, status, { error: err.message, code: err.code });
    } else {
      sendJson(res, 500, { error: 'internal' });
      console.error('[vibeshare]', err);
    }
  }

  // ------------------------------------------------------------- SSE

  #openStream(ctx: ShareContext, viewer: Viewer, res: ServerResponse): void {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
    });
    // Replay the recent log so late joiners see context, then go live.
    for (const entry of ctx.feed.backlog()) this.#sse(res, 'entry', entry, entry.seq);

    const unsubscribe = ctx.feed.subscribe((entry) => this.#sse(res, 'entry', entry, entry.seq));
    let set = ctx.streams.get(viewer.id);
    if (!set) {
      set = new Set();
      ctx.streams.set(viewer.id, set);
    }
    set.add(res);
    this.#broadcastViewers(ctx);

    res.on('close', () => {
      unsubscribe();
      set.delete(res);
      if (set.size === 0) ctx.streams.delete(viewer.id);
      this.#broadcastViewers(ctx);
    });
  }

  #sendToViewer(ctx: ShareContext, viewer: Viewer, event: string, data: unknown): void {
    for (const res of ctx.streams.get(viewer.id) ?? []) this.#sse(res, event, data);
  }

  #closeViewerStreams(ctx: ShareContext, viewer: Viewer, event: string | null): void {
    const set = ctx.streams.get(viewer.id);
    if (!set) return;
    for (const res of set) {
      if (event !== null) this.#sse(res, event, {});
      res.end();
    }
    ctx.streams.delete(viewer.id);
  }

  #broadcastViewers(ctx: ShareContext): void {
    const watching = streamCount(ctx);
    for (const set of ctx.streams.values()) {
      for (const res of set) this.#sse(res, 'viewers', { watching });
    }
  }

  #endAllStreams(ctx: ShareContext, state: string): void {
    for (const set of ctx.streams.values()) {
      for (const res of set) {
        this.#sse(res, 'ended', { state });
        res.end();
      }
    }
    ctx.streams.clear();
  }

  /**
   * Emit one SSE event. When e2e is on, the data line is the base64 of
   * `encryptFrame(key, JSON.stringify(data))` so a tunnel provider never
   * sees plaintext; otherwise it's plain JSON (default local path).
   */
  #sse(res: ServerResponse, event: string, data: unknown, id?: number): void {
    if (res.writableEnded) return;
    const idLine = id === undefined ? '' : `id: ${id}\n`;
    const payload = this.#e2eKey
      ? encryptFrame(this.#e2eKey, Buffer.from(JSON.stringify(data), 'utf8')).toString('base64')
      : JSON.stringify(data);
    res.write(`${idLine}event: ${event}\ndata: ${payload}\n\n`);
  }

  // -------------------------------------------------------------

  #publicBase(): string {
    if (this.#baseUrl) return this.#baseUrl.replace(/\/$/, '');
    const host = this.#host === '0.0.0.0' || this.#host === '::' ? lanAddress() ?? '127.0.0.1' : this.#host;
    return `http://${host}:${this.#boundPort}`;
  }
}

function streamCount(ctx: ShareContext): number {
  let n = 0;
  for (const set of ctx.streams.values()) n += set.size;
  return n;
}

function publicViewer(v: Viewer): Record<string, unknown> {
  return { id: v.id, name: v.name, role: v.role, joinRequest: v.joinRequest, joinedAt: v.joinedAt };
}

function sendJson(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  if (res.writableEnded) return;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function setSecurityHeaders(res: ServerResponse): void {
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('cache-control', 'no-store');
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY) throw new ShareError('bad-request', 'body too large');
    chunks.push(buf);
  }
  if (chunks.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function isLoopback(addr: string | undefined): boolean {
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

function tokenMatches(header: string | undefined, expected: string): boolean {
  if (!header?.startsWith('Bearer ')) return false;
  const got = Buffer.from(header.slice(7));
  const want = Buffer.from(expected);
  return got.length === want.length && timingSafeEqual(got, want);
}

function lanAddress(): string | null {
  for (const infos of Object.values(networkInterfaces())) {
    for (const info of infos ?? []) {
      if (info.family === 'IPv4' && !info.internal) return info.address;
    }
  }
  return null;
}
