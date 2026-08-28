/**
 * LocalHttpTransport — the default ShareTransport.
 * Manages live stream views, spectator SSE feeds, and local loopback host control.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { encryptFrame } from '@pooriaarab/vibe-core';
import type { SessionFeed } from '@pooriaarab/vibe-core/feed';
import { sanitizePresenceName, type ChatRelayFrame, type PresenceEntry } from './presenceChat.js';
import type { ViewerRegistry } from './registry.js';
import type { ShareTransport } from './transport.js';
import { ShareError, type Share, type Viewer } from './types.js';
import { newToken } from './utils.js';
import {
  isLoopback,
  lanAddress,
  sendJson,
  setSecurityHeaders,
  tokenMatches,
  streamCount,
  ERROR_STATUS_MAP,
  handleGoneShare,
} from './localHttp/helpers.js';
import type { ShareContext, RouteContext, ControlContext } from './localHttp/types.js';
import { ACTION_HANDLERS } from './localHttp/routes.js';
import { CONTROL_HANDLERS } from './localHttp/control.js';

export { type LocalHttpTransportOptions } from './localHttp/types.js';

export class LocalHttpTransport implements ShareTransport {
  readonly kind = 'local-http';
  readonly hostToken: string;
  readonly #host: string;
  readonly #port: number;
  readonly #baseUrl: string | undefined;
  readonly #onStop: ((shareId: string) => void) | undefined;
  readonly #e2eKey: Buffer | undefined;
  readonly #onChat: ((shareId: string, frame: { viewerId: string; name: string; text: string }) => void) | undefined;
  readonly #onAnnotation: ((shareId: string, frame: { viewerId: string; name: string; seq: number; text: string; replyTo?: string }) => void) | undefined;
  readonly #onInput: ((shareId: string, viewerId: string, data: string) => void) | undefined;
  readonly #onJoinRequest: ((shareId: string, viewer: Viewer) => void) | undefined;
  readonly #shares = new Map<string, ShareContext>();
  readonly #gone = new Set<string>();
  readonly #sockets = new Set<import('node:net').Socket>();
  #server: Server | null = null;
  #boundPort = 0;

  constructor(opts: import('./localHttp/types.js').LocalHttpTransportOptions = {}) {
    this.#host = opts.host ?? '127.0.0.1';
    this.#port = opts.port ?? 0;
    this.#baseUrl = opts.baseUrl;
    this.hostToken = opts.hostToken ?? newToken(24);
    this.#onStop = opts.onStopRequested;
    this.#e2eKey = opts.e2e?.key;
    this.#onChat = opts.onChat;
    this.#onAnnotation = opts.onAnnotation;
    this.#onInput = opts.onInput;
    this.#onJoinRequest = opts.onJoinRequest;
  }

  get e2eEnabled(): boolean {
    return this.#e2eKey !== undefined;
  }

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
    const broadcastPresence = () => this.#broadcastPresence(ctx);
    ctx.viewers.on('join', broadcastPresence);
    ctx.viewers.on('leave', (v) => (this.#closeViewerStreams(ctx, v, null), broadcastPresence()));
    ctx.viewers.on('kick', (v) => (this.#closeViewerStreams(ctx, v, 'kicked'), broadcastPresence()));
    ctx.viewers.on('request', (v) => (this.#onJoinRequest?.(ctx.share.id, v), broadcastPresence()));
    ctx.viewers.on('approve', (v) => (this.#sendToViewer(ctx, v, 'join-approved', { role: v.role }), broadcastPresence()));
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
    const m = /^\/s\/([A-Za-z0-9_-]+)(?:\/(meta|stream|join|request-join|input|leave|chat|annotate))?\/?$/.exec(path);
    if (!m) {
      sendJson(res, 404, { error: 'not found' });
      return;
    }
    const shareId = m[1];
    if (shareId === undefined) {
      sendJson(res, 404, { error: 'not found' });
      return;
    }
    const action = m[2] ?? 'page';
    const ctx = this.#shares.get(shareId);
    if (!ctx) {
      handleGoneShare(res, action, this.#gone.has(shareId));
      return;
    }
    const handler = Object.hasOwn(ACTION_HANDLERS, action) ? ACTION_HANDLERS[action] : undefined;
    if (!handler) {
      sendJson(res, 404, { error: 'not found' });
      return;
    }
    const rCtx: RouteContext = {
      ctx, req, res, url,
      e2eKey: this.#e2eKey,
      onChat: this.#onChat,
      onAnnotation: this.#onAnnotation,
      onInput: this.#onInput,
      openStream: (viewer, sRes) => this.#openStream(ctx, viewer, sRes),
      broadcastChat: (frame) => this.#broadcastChat(ctx, frame),
      broadcastAnnotation: (frame) => this.#broadcastAnnotation(ctx, frame),
      roster: () => this.#roster(ctx),
    };
    try {
      await handler(rCtx);
    } catch (err) {
      this.#handleError(res, err);
    }
  }

  #routeControl(req: IncomingMessage, res: ServerResponse, path: string, url: URL): void {
    if (!isLoopback(req.socket.remoteAddress) || !tokenMatches(req.headers.authorization, this.hostToken)) {
      sendJson(res, 401, { error: 'host-only control API' });
      return;
    }
    const handler = Object.hasOwn(CONTROL_HANDLERS, path) ? CONTROL_HANDLERS[path] : undefined;
    if (!handler) {
      sendJson(res, 404, { error: 'not found' });
      return;
    }
    const cCtx: ControlContext = {
      req, res, url,
      shares: this.#shares,
      onStop: this.#onStop,
      mustCtx: (shareId) => this.#mustCtx(shareId),
      unserve: (shareId) => this.unserve(shareId),
    };
    void (async () => {
      const result = await handler(cCtx);
      if (result !== undefined) {
        sendJson(res, 200, result);
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
      // Guarded like the other two table lookups in this file: a code that is
      // not an own key must fall back to 400, never to Object.prototype.
      const mapped = Object.hasOwn(ERROR_STATUS_MAP, err.code) ? ERROR_STATUS_MAP[err.code] : undefined;
      const status = mapped ?? 400;
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
    for (const entry of ctx.feed.backlog()) this.#sse(res, 'entry', entry, entry.seq);
    const unsubscribe = ctx.feed.subscribe((entry) => this.#sse(res, 'entry', entry, entry.seq));
    let set = ctx.streams.get(viewer.id);
    if (!set) {
      set = new Set();
      ctx.streams.set(viewer.id, set);
    }
    set.add(res);
    this.#broadcastPresence(ctx);
    res.on('close', () => {
      unsubscribe();
      set.delete(res);
      if (set.size === 0) ctx.streams.delete(viewer.id);
      this.#broadcastPresence(ctx);
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

  #roster(ctx: ShareContext): PresenceEntry[] {
    const viewers: PresenceEntry[] = [{ viewerId: 'host', name: 'host', role: 'host' }];
    for (const v of ctx.viewers.list()) {
      viewers.push({
        viewerId: v.id,
        name: sanitizePresenceName(v.name) || v.name,
        role: 'viewer',
      });
    }
    return viewers;
  }

  #broadcastPresence(ctx: ShareContext): void {
    const watching = streamCount(ctx);
    const viewers = this.#roster(ctx);
    const payload = { watching, viewers };
    for (const set of ctx.streams.values()) {
      for (const res of set) {
        this.#sse(res, 'viewers', payload);
        this.#sse(res, 'presence', payload);
      }
    }
  }

  #broadcastChat(ctx: ShareContext, frame: ChatRelayFrame): void {
    for (const set of ctx.streams.values()) {
      for (const res of set) this.#sse(res, 'chat', frame);
    }
  }

  #broadcastAnnotation(ctx: ShareContext, frame: import('./annotations.js').AnnotationRelayFrame): void {
    for (const set of ctx.streams.values()) {
      for (const res of set) this.#sse(res, 'annotation', frame);
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

  #sse(res: ServerResponse, event: string, data: unknown, id?: number): void {
    if (res.writableEnded) return;
    const idLine = id === undefined ? '' : `id: ${id}\n`;
    const payload = this.#e2eKey
      ? encryptFrame(this.#e2eKey, Buffer.from(JSON.stringify(data), 'utf8')).toString('base64')
      : JSON.stringify(data);
    res.write(`${idLine}event: ${event}\ndata: ${payload}\n\n`);
  }

  #publicBase(): string {
    if (this.#baseUrl) return this.#baseUrl.replace(/\/$/, '');
    const host = this.#host === '0.0.0.0' || this.#host === '::' ? lanAddress() ?? '127.0.0.1' : this.#host;
    return `http://${host}:${this.#boundPort}`;
  }
}
