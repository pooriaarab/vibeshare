/**
 * Multi-party hub frame handlers (hello / chat / annotation /
 * join-request / role-update) for the ShareRoom Durable Object. Each handler
 * is a pure function over the message + an endpoint handle; identity is
 * always STAMPED from the connection attachment — client-supplied identity
 * never reaches the wire. Dispatch happens in ShareRoom.handlePresenceChat.
 */
import { stampAnnotation } from '../../src/annotations.js';
import {
  defaultPresenceName,
  sanitizePresenceName,
  stampChatRelay,
} from '../../src/presenceChat.js';
import {
  type Attachment,
  broadcastAll,
  broadcastPresence,
  hostSocket,
  viewerSocket,
} from './roomIo.js';

/** The room's handles for one live socket (the two things handlers need). */
export interface MessageEndpoint {
  readonly ctx: DurableObjectState;
  readonly ws: WebSocket;
}

/** Parse a role-update `role` enum; null when not one of the two values. */
function parseRoleUpdateRole(value: unknown): 'spectator' | 'collaborator' | null {
  if (value === 'collaborator') return 'collaborator';
  if (value === 'spectator') return 'spectator';
  return null;
}

/** Parse a role-update `joinRequest` enum; null when not one of the four. */
function parseRoleUpdateJoin(value: unknown): 'approved' | 'denied' | 'pending' | 'none' | null {
  if (value === 'approved') return 'approved';
  if (value === 'denied') return 'denied';
  if (value === 'pending') return 'pending';
  if (value === 'none') return 'none';
  return null;
}

/**
 * `hello`: store a sanitized name on THIS socket's attachment so the next
 * roster picks it up. Returns true (handled).
 */
export function presenceHello(
  endpoint: MessageEndpoint,
  att: Attachment,
  msg: Record<string, unknown>,
  connectionViewerId?: string,
): boolean {
  const name =
    sanitizePresenceName(msg['name']) ||
    defaultPresenceName(att.role, connectionViewerId ?? att.viewerId ?? 'host');
  const next: Attachment = {
    role: att.role,
    shareId: att.shareId,
    name,
    ...(att.viewerId !== undefined ? { viewerId: att.viewerId } : {}),
    ...(att.connectedAt !== undefined ? { connectedAt: att.connectedAt } : {}),
  };
  endpoint.ws.serializeAttachment(next);
  broadcastPresence(endpoint.ctx);
  return true;
}

/**
 * `chat`: fan an identity-stamped chat line to everyone. Returns true when
 * handled (bad ciphertext is dropped, handled).
 */
export function presenceChat(
  endpoint: MessageEndpoint,
  att: Attachment,
  msg: Record<string, unknown>,
  connectionViewerId?: string,
): boolean {
  const viewerId = att.role === 'host' ? 'host' : (connectionViewerId ?? att.viewerId ?? '');
  if (viewerId.length === 0) return true; // drop, handled
  // Live attachment may have a fresher name than the message-time snapshot.
  const live = endpoint.ws.deserializeAttachment() as Attachment | null;
  const liveName = live?.name ?? att.name ?? '';
  const stamped = stampChatRelay({
    viewerId,
    name: liveName,
    role: att.role,
    text: msg['text'],
  });
  if (!stamped) return true; // bad ciphertext — drop
  // Discard any client-supplied identity: reconstruct server-side only.
  broadcastAll(endpoint.ctx, stamped);
  return true;
}

/**
 * `annotation`: viewer/host → everyone, a pinned comment anchored to a feed
 * seq. Identity stamped from the CONNECTION; id minted here; text stays
 * ciphertext. Only seq (anchor) + replyTo (threading) pass through.
 */
export function presenceAnnotation(
  endpoint: MessageEndpoint,
  att: Attachment,
  msg: Record<string, unknown>,
  connectionViewerId?: string,
): boolean {
  const viewerId = att.role === 'host' ? 'host' : (connectionViewerId ?? att.viewerId ?? '');
  if (viewerId.length === 0) return true; // drop, handled
  // Live attachment may have a fresher name than the message-time snapshot.
  const live = endpoint.ws.deserializeAttachment() as Attachment | null;
  const liveName = live?.name ?? att.name ?? '';
  const stamped = stampAnnotation({
    id: crypto.randomUUID(),
    viewerId,
    name: liveName,
    role: att.role,
    seq: msg['seq'],
    text: msg['text'],
    replyTo: msg['replyTo'],
  });
  if (!stamped) return true; // bad payload — drop
  broadcastAll(endpoint.ctx, stamped);
  return true;
}

/**
 * `join-request`: viewer → host request to drive. Identity from CONNECTION
 * only; a host cannot self-request (returns true — drop, handled).
 */
export function presenceJoinRequest(
  endpoint: MessageEndpoint,
  att: Attachment,
  msg: Record<string, unknown>,
  connectionViewerId?: string,
): boolean {
  if (att.role !== 'viewer') return true; // host cannot self-request
  const viewerId = connectionViewerId ?? att.viewerId ?? '';
  if (viewerId.length === 0) return true;
  const live = endpoint.ws.deserializeAttachment() as Attachment | null;
  const name =
    sanitizePresenceName(live?.name ?? att.name) ||
    defaultPresenceName('viewer', viewerId);
  const host = hostSocket(endpoint.ctx);
  if (host) {
    host.send(
      JSON.stringify({
        kind: 'join-request',
        viewerId,
        name,
      }),
    );
  }
  return true;
}

/**
 * `role-update`: host → one viewer; role decision after approve/deny.
 * Viewers cannot mint role updates (returns true — drop, handled).
 */
export function presenceRoleUpdate(
  endpoint: MessageEndpoint,
  att: Attachment,
  msg: Record<string, unknown>,
): boolean {
  if (att.role !== 'host') return true; // viewers cannot mint role updates
  const viewerId = typeof msg['viewerId'] === 'string' ? msg['viewerId'] : '';
  if (viewerId.length === 0) return true;
  const role = parseRoleUpdateRole(msg['role']);
  if (!role) return true;
  const joinRequest = parseRoleUpdateJoin(msg['joinRequest']);
  if (!joinRequest) return true;
  sendRoleUpdate(endpoint.ctx, viewerId, role, joinRequest);
  return true;
}

/** Send a validated role-update decision to one viewer socket (if live). */
function sendRoleUpdate(
  ctx: DurableObjectState,
  viewerId: string,
  role: 'spectator' | 'collaborator',
  joinRequest: 'approved' | 'denied' | 'pending' | 'none',
): void {
  const viewer = viewerSocket(ctx, viewerId);
  if (viewer) {
    viewer.send(
      JSON.stringify({
        kind: 'role-update',
        viewerId,
        role,
        joinRequest,
      }),
    );
  }
}