import type { AnnotationRelayFrame } from '../annotations.js';
import { sanitizeIceServers } from '../config.js';
import type {
  ChatRelayFrame,
  JoinRequestFrame,
  PresenceEntry,
  PresenceFrame,
} from '../presenceChat.js';
import type { SignalingFrame, SignalingSide } from './signaling.js';

export function pairKey(shareId: string, viewerId: string): string {
  return `${shareId}/${viewerId}`;
}

export function parseMessage(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function asOffer(msg: Record<string, unknown>): SignalingFrame | null {
  const { kind, shareId, viewerId, sdp } = msg;
  if (kind !== 'rtc-offer' || typeof shareId !== 'string' || typeof viewerId !== 'string' || typeof sdp !== 'string') {
    return null;
  }
  return { kind: 'rtc-offer', shareId, viewerId, sdp };
}

export function asIceServers(msg: Record<string, unknown>): SignalingFrame | null {
  const { kind, shareId, viewerId } = msg;
  if (kind !== 'rtc-ice-servers' || typeof shareId !== 'string' || typeof viewerId !== 'string') {
    return null;
  }
  // Same validation as the config file: garbage entries drop out, and a list
  // with nothing valid is treated as absent (the viewer keeps its default).
  const iceServers = sanitizeIceServers(msg['iceServers']);
  if (!iceServers) return null;
  return { kind: 'rtc-ice-servers', shareId, viewerId, iceServers };
}

export function asAnswer(msg: Record<string, unknown>): SignalingFrame | null {
  const { kind, shareId, viewerId, sdp } = msg;
  if (kind !== 'rtc-answer' || typeof shareId !== 'string' || typeof viewerId !== 'string' || typeof sdp !== 'string') {
    return null;
  }
  return { kind: 'rtc-answer', shareId, viewerId, sdp };
}

export function asIce(msg: Record<string, unknown>, from: SignalingSide): SignalingFrame | null {
  const { kind, shareId, viewerId, candidate, mid } = msg;
  if (
    kind !== 'rtc-ice' ||
    typeof shareId !== 'string' ||
    typeof viewerId !== 'string' ||
    typeof candidate !== 'string' ||
    typeof mid !== 'string'
  ) {
    return null;
  }
  return { kind: 'rtc-ice', shareId, viewerId, candidate, mid, from };
}

export function parsePresenceEntry(raw: unknown): PresenceEntry | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const row = raw as Record<string, unknown>;
  if (typeof row['viewerId'] !== 'string' || typeof row['name'] !== 'string') return null;
  const role = row['role'] === 'host' ? 'host' : row['role'] === 'viewer' ? 'viewer' : null;
  if (!role) return null;
  return { viewerId: row['viewerId'], name: row['name'], role };
}

export function asPresence(msg: Record<string, unknown>): PresenceFrame | null {
  if (msg['kind'] !== 'presence' || !Array.isArray(msg['viewers'])) return null;
  const viewers: PresenceEntry[] = [];
  for (const raw of msg['viewers']) {
    const entry = parsePresenceEntry(raw);
    if (entry) viewers.push(entry);
  }
  return { kind: 'presence', viewers };
}

export function parseRole(role: unknown): 'host' | 'viewer' | null {
  return role === 'host' ? 'host' : role === 'viewer' ? 'viewer' : null;
}

export function parseTs(ts: unknown): number {
  return typeof ts === 'number' ? ts : Date.now();
}

export function asChat(msg: Record<string, unknown>): ChatRelayFrame | null {
  if (msg['kind'] !== 'chat') return null;
  if (typeof msg['viewerId'] !== 'string') return null;
  if (typeof msg['name'] !== 'string') return null;
  if (typeof msg['text'] !== 'string') return null;
  const role = parseRole(msg['role']);
  if (!role) return null;
  const ts = parseTs(msg['ts']);
  return {
    kind: 'chat',
    viewerId: msg['viewerId'],
    name: msg['name'],
    role,
    text: msg['text'],
    ts,
  };
}

export function asJoinRequest(msg: Record<string, unknown>): JoinRequestFrame | null {
  if (msg['kind'] !== 'join-request') return null;
  if (typeof msg['viewerId'] !== 'string' || msg['viewerId'].length === 0) return null;
  if (typeof msg['name'] !== 'string') return null;
  return { kind: 'join-request', viewerId: msg['viewerId'], name: msg['name'] };
}

export function validateAnnotationId(id: unknown): id is string {
  return typeof id === 'string' && id.length > 0;
}

export function validateAnnotationSeq(seq: unknown): seq is number {
  return typeof seq === 'number' && Number.isInteger(seq) && seq >= 0;
}

export function parseReplyTo(replyTo: unknown): string | undefined {
  return typeof replyTo === 'string' && replyTo.length > 0 ? replyTo : undefined;
}

export function asAnnotation(msg: Record<string, unknown>): AnnotationRelayFrame | null {
  if (msg['kind'] !== 'annotation') return null;
  if (!validateAnnotationId(msg['id'])) return null;
  if (!validateAnnotationSeq(msg['seq'])) return null;
  if (typeof msg['viewerId'] !== 'string') return null;
  if (typeof msg['name'] !== 'string') return null;
  if (typeof msg['text'] !== 'string') return null;

  const role = parseRole(msg['role']);
  if (!role) return null;

  const replyTo = parseReplyTo(msg['replyTo']);
  const ts = parseTs(msg['ts']);

  return {
    kind: 'annotation',
    id: msg['id'],
    seq: msg['seq'],
    viewerId: msg['viewerId'],
    name: msg['name'],
    role,
    text: msg['text'],
    ...(replyTo !== undefined ? { replyTo } : {}),
    ts,
  };
}
