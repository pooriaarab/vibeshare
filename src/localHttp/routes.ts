import { randomUUID } from 'node:crypto';
import { sanitizePeerText } from '@pooriaarab/vibe-core';
import { spectatorPage } from '../spectatorPage.js';
import { ShareError, type Viewer } from '../types.js';
import { verifyPassphrase } from '../utils.js';
import {
  MAX_ANNOTATION_PLAINTEXT_LEN,
  normalizeReplyTo,
  parseAnchorSeq,
  stampAnnotation,
  type AnnotationRelayFrame,
} from '../annotations.js';
import { decryptAnnotationText } from '../annotationsCrypto.js';
import {
  MAX_CHAT_PLAINTEXT_LEN,
  sanitizePresenceName,
  stampChatRelay,
  type ChatRelayFrame,
} from '../presenceChat.js';
import { decryptChatText } from '../presenceChatCrypto.js';
import { readJsonBody, sendJson, streamCount } from './helpers.js';
import type { RouteContext } from './types.js';

async function handlePage(rCtx: RouteContext): Promise<void> {
  const { req, res, ctx, e2eKey } = rCtx;
  if (req.method !== 'GET') return void sendJson(res, 405, { error: 'method not allowed' });
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(spectatorPage(ctx.share, { e2e: e2eKey !== undefined }));
}

async function handleMeta(rCtx: RouteContext): Promise<void> {
  const { res, ctx, roster } = rCtx;
  sendJson(res, 200, {
    id: ctx.share.id,
    name: ctx.share.name,
    access: ctx.share.access,
    state: ctx.share.state,
    requiresPassphrase: ctx.share.passphraseHash !== null,
    watching: streamCount(ctx),
    viewers: roster(),
  });
}

async function handleJoin(rCtx: RouteContext): Promise<void> {
  const { req, res, ctx } = rCtx;
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
}

async function handleStream(rCtx: RouteContext): Promise<void> {
  const { req, res, url, ctx, openStream } = rCtx;
  if (req.method !== 'GET') return void sendJson(res, 405, { error: 'method not allowed' });
  const viewer = ctx.viewers.getByToken(url.searchParams.get('token') ?? '');
  if (!viewer) return void sendJson(res, 401, { error: 'unknown viewer token' });
  openStream(viewer, res);
}

async function handleRequestJoin(rCtx: RouteContext): Promise<void> {
  const { req, res, ctx } = rCtx;
  if (req.method !== 'POST') return void sendJson(res, 405, { error: 'method not allowed' });
  const body = await readJsonBody(req);
  const viewer = ctx.viewers.getByToken(typeof body['token'] === 'string' ? body['token'] : '');
  if (!viewer) return void sendJson(res, 401, { error: 'unknown viewer token' });
  ctx.viewers.requestJoin(viewer.id);
  sendJson(res, 202, { status: 'pending' });
}

/**
 * Identity from the viewer TOKEN — never from the body. canWrite is the single
 * gate; spectate shares and unapproved invitees get 403.
 */
async function handleInput(rCtx: RouteContext): Promise<void> {
  const { req, res, ctx, onInput } = rCtx;
  if (req.method !== 'POST') return void sendJson(res, 405, { error: 'method not allowed' });
  if (ctx.share.state !== 'live') throw new ShareError('not-live', 'share has ended');
  const body = await readJsonBody(req);
  const viewer = ctx.viewers.getByToken(typeof body['token'] === 'string' ? body['token'] : '');
  if (!viewer) return void sendJson(res, 401, { error: 'unknown viewer token' });
  if (!ctx.viewers.canWrite(viewer.id)) {
    throw new ShareError('not-promoted', 'not approved to drive this session');
  }
  const data = typeof body['data'] === 'string' ? body['data'] : '';
  if (data.length === 0) return void sendJson(res, 400, { error: 'empty input' });
  // Cap a single frame so a runaway client can't flood the PTY.
  const capped = data.length > 4096 ? data.slice(0, 4096) : data;
  onInput?.(ctx.share.id, viewer.id, capped);
  sendJson(res, 202, { ok: true });
}

async function handleLeave(rCtx: RouteContext): Promise<void> {
  const { req, res, url, ctx } = rCtx;
  if (req.method !== 'POST') return void sendJson(res, 405, { error: 'method not allowed' });
  let token = url.searchParams.get('token') ?? '';
  if (token.length === 0) {
    const body = await readJsonBody(req);
    if (typeof body['token'] === 'string') token = body['token'];
  }
  const viewer = ctx.viewers.getByToken(token);
  if (viewer) ctx.viewers.leave(viewer.id);
  sendJson(res, 200, { ok: true });
}

interface ChatPayload {
  relayText: string;
  displayText: string;
}

/**
 * Tunnel path: the client sent ciphertext; relay it opaque and decrypt only
 * for the host terminal callback.
 */
function processE2eChat(
  e2eKey: Buffer,
  viewer: Viewer,
  wireText: string,
  broadcastChat: (frame: ChatRelayFrame) => void,
): ChatPayload {
  const stamped = stampChatRelay({
    viewerId: viewer.id,
    name: viewer.name,
    role: 'viewer',
    text: wireText,
  });
  if (!stamped) throw new ShareError('bad-request', 'invalid chat payload');
  const displayText = decryptChatText(e2eKey, stamped.text) ?? '';
  broadcastChat(stamped);
  return { relayText: stamped.text, displayText };
}

/** Local plaintext path: sanitize and stamp; no share key on the URL. */
function processPlainChat(
  viewer: Viewer,
  wireText: string,
  broadcastChat: (frame: ChatRelayFrame) => void,
): ChatPayload {
  const displayText = sanitizePeerText(wireText, MAX_CHAT_PLAINTEXT_LEN).trim();
  if (displayText.length === 0) throw new ShareError('bad-request', 'empty chat');
  const frame: ChatRelayFrame = {
    kind: 'chat',
    viewerId: viewer.id,
    name: sanitizePresenceName(viewer.name) || viewer.name,
    role: 'viewer',
    text: displayText,
    ts: Date.now(),
  };
  broadcastChat(frame);
  return { relayText: displayText, displayText };
}

function triggerChatCallback(
  onChat: RouteContext['onChat'],
  shareId: string,
  viewer: Viewer,
  displayText: string,
): void {
  if (displayText.length === 0 || !onChat) return;
  onChat(shareId, {
    viewerId: viewer.id,
    name: sanitizePresenceName(viewer.name) || viewer.name,
    text: displayText,
  });
}

/** Identity from the TOKEN / registry — never from the payload. */
async function handleChat(rCtx: RouteContext): Promise<void> {
  const { req, res, ctx, e2eKey, onChat, broadcastChat } = rCtx;
  if (req.method !== 'POST') return void sendJson(res, 405, { error: 'method not allowed' });
  if (ctx.share.state !== 'live') throw new ShareError('not-live', 'share has ended');
  const body = await readJsonBody(req);
  const viewer = ctx.viewers.getByToken(typeof body['token'] === 'string' ? body['token'] : '');
  if (!viewer) return void sendJson(res, 401, { error: 'unknown viewer token' });
  const wireText = typeof body['text'] === 'string' ? body['text'] : '';
  const { displayText } = e2eKey
    ? processE2eChat(e2eKey, viewer, wireText, broadcastChat)
    : processPlainChat(viewer, wireText, broadcastChat);

  triggerChatCallback(onChat, ctx.share.id, viewer, displayText);
  sendJson(res, 202, { ok: true });
}

interface E2eAnnotationOpts {
  readonly e2eKey: Buffer;
  readonly viewer: Viewer;
  readonly seq: number;
  readonly wireText: string;
  readonly replyTo: string | undefined;
  readonly broadcastAnnotation: (frame: AnnotationRelayFrame) => void;
}

/**
 * Tunnel path: the client sent ciphertext; relay it opaque and decrypt only
 * for the host terminal callback.
 */
function processE2eAnnotation(opts: E2eAnnotationOpts): string {
  const { e2eKey, viewer, seq, wireText, replyTo, broadcastAnnotation } = opts;
  const stamped = stampAnnotation({
    id: randomUUID(),
    viewerId: viewer.id,
    name: viewer.name,
    role: 'viewer',
    seq,
    text: wireText,
    ...(replyTo !== undefined ? { replyTo } : {}),
  });
  if (!stamped) throw new ShareError('bad-request', 'invalid annotation payload');
  const displayText = decryptAnnotationText(e2eKey, stamped.text) ?? '';
  broadcastAnnotation(stamped);
  return displayText;
}

interface PlainAnnotationOpts {
  readonly viewer: Viewer;
  readonly seq: number;
  readonly wireText: string;
  readonly replyTo: string | undefined;
  readonly broadcastAnnotation: (frame: AnnotationRelayFrame) => void;
}

/** Local plaintext path: sanitize and stamp; no share key on the URL. */
function processPlainAnnotation(opts: PlainAnnotationOpts): string {
  const { viewer, seq, wireText, replyTo, broadcastAnnotation } = opts;
  const displayText = sanitizePeerText(wireText, MAX_ANNOTATION_PLAINTEXT_LEN).trim();
  if (displayText.length === 0) throw new ShareError('bad-request', 'empty annotation');
  const frame: AnnotationRelayFrame = {
    kind: 'annotation',
    id: randomUUID(),
    seq,
    viewerId: viewer.id,
    name: sanitizePresenceName(viewer.name) || viewer.name,
    role: 'viewer',
    text: displayText,
    ...(replyTo !== undefined ? { replyTo } : {}),
    ts: Date.now(),
  };
  broadcastAnnotation(frame);
  return displayText;
}

interface AnnotationCallbackOpts {
  readonly onAnnotation: RouteContext['onAnnotation'];
  readonly shareId: string;
  readonly viewer: Viewer;
  readonly seq: number;
  readonly displayText: string;
  readonly replyTo: string | undefined;
}

function triggerAnnotationCallback(opts: AnnotationCallbackOpts): void {
  const { onAnnotation, shareId, viewer, seq, displayText, replyTo } = opts;
  if (displayText.length === 0 || !onAnnotation) return;
  onAnnotation(shareId, {
    viewerId: viewer.id,
    name: sanitizePresenceName(viewer.name) || viewer.name,
    seq,
    text: displayText,
    ...(replyTo !== undefined ? { replyTo } : {}),
  });
}

interface AnnotateRequest {
  readonly seq: number;
  readonly replyTo: string | undefined;
  readonly wireText: string;
}

/**
 * Read the annotate body, minus the token: the caller has already rejected an
 * unknown one. That order matters — the original route validated the anchor
 * only after the token check, so an unauthenticated request must still answer
 * 401 rather than a bad-request revealing the anchor was parsed.
 */
function parseAnnotateRequest(body: Record<string, unknown>): AnnotateRequest {
  const seq = parseAnchorSeq(body['seq']);
  if (seq === null) throw new ShareError('bad-request', 'invalid annotation anchor');
  return {
    seq,
    replyTo: normalizeReplyTo(body['replyTo']),
    wireText: typeof body['text'] === 'string' ? body['text'] : '',
  };
}

/**
 * A pinned comment anchored to a feed seq. Identity from the viewer TOKEN —
 * never from the payload; id minted here; only seq (anchor) and replyTo
 * (threading) pass through from the body.
 */
async function handleAnnotate(rCtx: RouteContext): Promise<void> {
  const { req, res, ctx, e2eKey, onAnnotation, broadcastAnnotation } = rCtx;
  if (req.method !== 'POST') return void sendJson(res, 405, { error: 'method not allowed' });
  if (ctx.share.state !== 'live') throw new ShareError('not-live', 'share has ended');
  const body = await readJsonBody(req);
  const viewer = ctx.viewers.getByToken(typeof body['token'] === 'string' ? body['token'] : '');
  if (!viewer) return void sendJson(res, 401, { error: 'unknown viewer token' });
  const reqData = parseAnnotateRequest(body);

  const displayText = e2eKey
    ? processE2eAnnotation({ e2eKey, viewer, seq: reqData.seq, wireText: reqData.wireText, replyTo: reqData.replyTo, broadcastAnnotation })
    : processPlainAnnotation({ viewer, seq: reqData.seq, wireText: reqData.wireText, replyTo: reqData.replyTo, broadcastAnnotation });

  triggerAnnotationCallback({ onAnnotation, shareId: ctx.share.id, viewer, seq: reqData.seq, displayText, replyTo: reqData.replyTo });
  sendJson(res, 202, { ok: true });
}

export const ACTION_HANDLERS: Record<
  string,
  (rCtx: RouteContext) => Promise<void>
> = {
  page: handlePage,
  meta: handleMeta,
  join: handleJoin,
  stream: handleStream,
  'request-join': handleRequestJoin,
  input: handleInput,
  leave: handleLeave,
  chat: handleChat,
  annotate: handleAnnotate,
};
export { handlePage, handleMeta, handleJoin, handleStream, handleRequestJoin, handleInput, handleLeave, handleChat, handleAnnotate };
