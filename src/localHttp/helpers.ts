import { type IncomingMessage, type ServerResponse } from 'node:http';
import { networkInterfaces } from 'node:os';
import { timingSafeEqual } from 'node:crypto';
import { ShareError, type Viewer } from '../types.js';
import type { ShareContext } from './types.js';

export const MAX_BODY = 64 * 1024;

export const ERROR_STATUS_MAP: Record<string, number> = {
  'not-found': 404,
  'not-live': 410,
  'passphrase-required': 403,
  'passphrase-invalid': 403,
  'invite-disabled': 403,
  'not-promoted': 403,
  'already-pending': 409,
  'not-pending': 409,
};

export function streamCount(ctx: ShareContext): number {
  let n = 0;
  for (const set of ctx.streams.values()) {
    n += set.size;
  }
  return n;
}

export function publicViewer(v: Viewer): Record<string, unknown> {
  return { id: v.id, name: v.name, role: v.role, joinRequest: v.joinRequest, joinedAt: v.joinedAt };
}

export function sendJson(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  if (res.writableEnded) return;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

export function setSecurityHeaders(res: ServerResponse): void {
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('cache-control', 'no-store');
}

export async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY) {
      throw new ShareError('bad-request', 'body too large');
    }
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

export function isLoopback(addr: string | undefined): boolean {
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

export function tokenMatches(header: string | undefined, expected: string): boolean {
  if (!header?.startsWith('Bearer ')) return false;
  const got = Buffer.from(header.slice(7));
  const want = Buffer.from(expected);
  return got.length === want.length && timingSafeEqual(got, want);
}

export function lanAddress(): string | null {
  for (const infos of Object.values(networkInterfaces())) {
    for (const info of infos ?? []) {
      if (info.family === 'IPv4' && !info.internal) return info.address;
    }
  }
  return null;
}

export function handleGoneShare(res: ServerResponse, action: string, isGone: boolean): void {
  const status = isGone ? 410 : 404;
  if (action === 'page') {
    res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!DOCTYPE html><title>vibeshare</title><body style="background:#0a0b0f;color:#edeef3;font-family:sans-serif;display:grid;place-items:center;min-height:100vh;margin:0"><p>This share has ended.</p></body>');
  } else {
    sendJson(res, status, { error: isGone ? 'share ended' : 'not found' });
  }
}
