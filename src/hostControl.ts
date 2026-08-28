/**
 * Loopback host-control HTTP server.
 *
 * `vibeshare viewers --approve` / `--deny` / `--kick` and `vibeshare stop`
 * talk to the sharing process over 127.0.0.1 + a bearer host token. For
 * local-http / tunnel shares this is the same server as LocalHttpTransport.
 * For `--public` (WebRTC) shares there is no spectator HTTP server, so this
 * tiny control-only listener exposes the same `/control/*` routes against
 * the in-process ViewerRegistry.
 *
 * Never bound to a non-loopback address — host-only by construction.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import type { ViewerRegistry } from './registry.js';
import { ShareError, type Viewer } from './types.js';
import { newToken } from './utils.js';

export interface HostControlShare {
  readonly id: string;
  readonly viewers: ViewerRegistry;
}

export interface HostControlOptions {
  /** Called when control asks to stop a share (`vibeshare stop`). */
  readonly onStopRequested?: (shareId: string) => void;
  /** Bearer token; generated when omitted. */
  readonly hostToken?: string;
}

export class HostControlServer {
  readonly hostToken: string;
  readonly #onStop: ((shareId: string) => void) | undefined;
  readonly #shares = new Map<string, HostControlShare>();
  #server: Server | null = null;
  #boundPort = 0;

  constructor(opts: HostControlOptions = {}) {
    this.hostToken = opts.hostToken ?? newToken(24);
    this.#onStop = opts.onStopRequested;
  }

  get port(): number {
    return this.#boundPort;
  }

  /** Register a live share so control routes can find its registry. */
  track(share: HostControlShare): void {
    this.#shares.set(share.id, share);
  }

  untrack(shareId: string): void {
    this.#shares.delete(shareId);
  }

  async listen(): Promise<void> {
    if (this.#server) return;
    const server = createServer((req, res) => {
      void this.#route(req, res).catch((err: unknown) => this.#handleError(res, err));
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      // Loopback only — never expose host control on the LAN.
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = server.address();
    this.#boundPort = typeof addr === 'object' && addr !== null ? addr.port : 0;
    this.#server = server;
  }

  async close(): Promise<void> {
    this.#shares.clear();
    const server = this.#server;
    this.#server = null;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  #handleViewers(params: URLSearchParams, res: ServerResponse): void {
    const share = this.#must(params.get('share') ?? '');
    sendJson(res, 200, {
      viewers: share.viewers.list().map(publicViewer),
      watching: share.viewers.count(),
    });
  }

  async #handleViewerAction(
    path: string,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'method not allowed' });
      return;
    }
    const body = await readJsonBody(req);
    const share = this.#must(typeof body['share'] === 'string' ? body['share'] : '');
    const viewerId = typeof body['viewer'] === 'string' ? body['viewer'] : '';
    const action = path.slice('/control/'.length) as 'approve' | 'deny' | 'kick';
    const viewer = share.viewers[action](viewerId);
    sendJson(res, 200, { viewer: publicViewer(viewer) });
  }

  async #handleStop(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'method not allowed' });
      return;
    }
    const body = await readJsonBody(req);
    const shareId = typeof body['share'] === 'string' ? body['share'] : '';
    this.#must(shareId);
    sendJson(res, 200, { stopped: shareId });
    this.#onStop?.(shareId);
  }

  async #route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('cache-control', 'no-store');
    if (!isLoopback(req.socket.remoteAddress) || !tokenMatches(req.headers.authorization, this.hostToken)) {
      sendJson(res, 401, { error: 'host-only control API' });
      return;
    }
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;

    if (path === '/control/viewers') {
      this.#handleViewers(url.searchParams, res);
      return;
    }

    if (path === '/control/approve' || path === '/control/deny' || path === '/control/kick') {
      await this.#handleViewerAction(path, req, res);
      return;
    }

    if (path === '/control/stop') {
      await this.#handleStop(req, res);
      return;
    }

    sendJson(res, 404, { error: 'not found' });
  }

  #must(shareId: string): HostControlShare {
    const s = this.#shares.get(shareId);
    if (!s) throw new ShareError('not-found', `no live share ${shareId}`);
    return s;
  }

  #handleError(res: ServerResponse, err: unknown): void {
    if (res.writableEnded) return;
    if (err instanceof ShareError) {
      const status =
        err.code === 'not-found' ? 404
        : err.code === 'already-pending' || err.code === 'not-pending' ? 409
        : err.code === 'invite-disabled' ? 403
        : 400;
      sendJson(res, status, { error: err.message, code: err.code });
    } else {
      sendJson(res, 500, { error: 'internal' });
    }
  }
}

function publicViewer(v: Viewer): Record<string, unknown> {
  return { id: v.id, name: v.name, role: v.role, joinRequest: v.joinRequest, joinedAt: v.joinedAt };
}

function sendJson(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  if (res.writableEnded) return;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function isLoopback(addr: string | undefined): boolean {
  if (!addr) return false;
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

function tokenMatches(header: string | undefined, expected: string): boolean {
  if (!header || !header.startsWith('Bearer ')) return false;
  const got = header.slice('Bearer '.length);
  const a = Buffer.from(got);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > 64 * 1024) throw new ShareError('bad-request', 'body too large');
    chunks.push(buf);
  }
  if (chunks.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}
