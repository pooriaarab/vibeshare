/**
 * Room I/O helpers for the ShareRoom Durable Object — socket attachment
 * bookkeeping, per-connection setup ordering, alarm deadlines and presence
 * broadcast, all pure over `DurableObjectState` (no ShareRoom instance
 * state, so they can live outside the class while the class stays small).
 */
import { buildPresenceRoster, defaultPresenceName } from '../../src/presenceChat.js';
import {
  VIEWER_HOST_WAIT_MS,
  hostActivityDeadline,
  viewerHostWaitExpired,
} from './limits.js';

/** Per-connection state, serialized into the socket (survives hibernation). */
export interface Attachment {
  readonly role: 'host' | 'viewer';
  readonly shareId: string;
  readonly viewerId?: string;
  /** Display name from a hello frame (sanitized); may be empty until hello. */
  readonly name?: string;
  /** Epoch ms when this viewer socket connected (for no-host timeout). */
  readonly connectedAt?: number;
}

/** Close a socket, tolerating one that is already closing/closed. */
export function closeQuietly(ws: WebSocket, code: number, reason: string): void {
  try {
    ws.close(code, reason);
  } catch {
    // already closed
  }
}

/** Roles of every live socket, in socket order. */
export function socketRoles(ctx: DurableObjectState): Array<'host' | 'viewer'> {
  const roles: Array<'host' | 'viewer'> = [];
  for (const ws of ctx.getWebSockets()) {
    const att = ws.deserializeAttachment() as Attachment | null;
    if (att?.role === 'host' || att?.role === 'viewer') roles.push(att.role);
  }
  return roles;
}

export function hostSocket(ctx: DurableObjectState): WebSocket | undefined {
  for (const ws of ctx.getWebSockets()) {
    const att = ws.deserializeAttachment() as Attachment | null;
    if (att?.role === 'host') return ws;
  }
  return undefined;
}

export function viewerSocket(ctx: DurableObjectState, viewerId: string): WebSocket | undefined {
  for (const ws of ctx.getWebSockets()) {
    const att = ws.deserializeAttachment() as Attachment | null;
    if (att?.role === 'viewer' && att.viewerId === viewerId) return ws;
  }
  return undefined;
}

/** Fan one frame to every live socket, tolerating closing ones. */
export function broadcastAll(ctx: DurableObjectState, frame: unknown): void {
  const text = JSON.stringify(frame);
  for (const ws of ctx.getWebSockets()) {
    try {
      ws.send(text);
    } catch {
      // socket already closing
    }
  }
}

/** Fan a presence roster snapshot to every connected socket. */
export function broadcastPresence(ctx: DurableObjectState): void {
  const attachments: Attachment[] = [];
  for (const ws of ctx.getWebSockets()) {
    const att = ws.deserializeAttachment() as Attachment | null;
    if (att) attachments.push(att);
  }
  const viewers = buildPresenceRoster(attachments);
  broadcastAll(ctx, { kind: 'presence', viewers });
}

/**
 * Host branch of ShareRoom.fetch — serialize the host attachment, accept the
 * socket, send `host-ready`, extend the hard storage ceiling and rebroadcast
 * the roster. Order is load-bearing (see ShareRoom.fetch).
 */
export async function acceptHostConnection(
  ctx: DurableObjectState,
  server: WebSocket,
  shareId: string,
  now: number,
): Promise<void> {
  for (const ws of ctx.getWebSockets()) {
    const att = ws.deserializeAttachment() as Attachment | null;
    if (att?.role === 'host') ws.close(1012, 'host reconnected');
  }
  server.serializeAttachment({
    role: 'host',
    shareId,
    name: 'host',
  } satisfies Attachment);
  ctx.acceptWebSocket(server);
  server.send(JSON.stringify({ kind: 'host-ready' }));
  // Hard ceiling on storage life; reset on every host connect so a live
  // long share isn't wiped. alarm() re-arms while the host is still up.
  await ctx.storage.setAlarm(hostActivityDeadline(now));
  broadcastPresence(ctx);
}

/**
 * Viewer branch of ShareRoom.fetch — the Worker ASSIGNS the viewerId (the
 * viewer never chooses one). Serialize, accept, send `assigned`, notify the
 * host (or schedule the no-host wait), then rebroadcast the roster.
 */
export async function acceptViewerConnection(
  ctx: DurableObjectState,
  server: WebSocket,
  shareId: string,
  now: number,
): Promise<void> {
  const viewerId = crypto.randomUUID();
  server.serializeAttachment({
    role: 'viewer',
    shareId,
    viewerId,
    name: defaultPresenceName('viewer', viewerId),
    connectedAt: now,
  } satisfies Attachment);
  ctx.acceptWebSocket(server);
  server.send(JSON.stringify({ kind: 'assigned', viewerId }));
  const host = hostSocket(ctx);
  if (host) {
    host.send(JSON.stringify({ kind: 'viewer-joined', viewerId }));
  } else {
    // No host yet: schedule a reject so a guessed id doesn't hold a socket.
    await ensureViewerHostWaitAlarm(ctx, now);
  }
  broadcastPresence(ctx);
}

/** Close viewers whose no-host wait has elapsed (1013 / "share not found"). */
export function closeExpiredViewerWaits(ctx: DurableObjectState, now: number): void {
  for (const ws of ctx.getWebSockets()) {
    const att = ws.deserializeAttachment() as Attachment | null;
    if (att?.role !== 'viewer' || att.connectedAt === undefined) continue;
    if (viewerHostWaitExpired(att.connectedAt, now)) {
      closeQuietly(ws, 1013, 'share not found');
    }
  }
}

/** Close every live socket, tolerating already-closed ones. */
export function closeAll(ctx: DurableObjectState, code: number, reason: string): void {
  for (const ws of ctx.getWebSockets()) {
    closeQuietly(ws, code, reason);
  }
}

/**
 * Ensure a DO alarm will fire by the soonest viewer no-host deadline.
 * setAlarm replaces any previous alarm; only bump if we need an earlier one
 * (do not postpone an abandoned/hard-ceiling cleanup already scheduled sooner).
 */
export async function ensureViewerHostWaitAlarm(ctx: DurableObjectState, connectedAt: number): Promise<void> {
  const due = connectedAt + VIEWER_HOST_WAIT_MS;
  const existing = await ctx.storage.getAlarm();
  if (existing === null || due < existing) {
    await ctx.storage.setAlarm(due);
  }
}

/** Next connectedAt+VIEWER_HOST_WAIT_MS among still-waiting viewers, or null. */
export function nextViewerHostWaitAlarm(ctx: DurableObjectState, now: number): number | null {
  let next: number | null = null;
  for (const ws of ctx.getWebSockets()) {
    const att = ws.deserializeAttachment() as Attachment | null;
    if (att?.role !== 'viewer' || att.connectedAt === undefined) continue;
    const due = att.connectedAt + VIEWER_HOST_WAIT_MS;
    if (due <= now) continue;
    if (next === null || due < next) next = due;
  }
  return next;
}