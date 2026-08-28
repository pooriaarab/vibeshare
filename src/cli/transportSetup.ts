import { randomBytes } from 'node:crypto';
import { createTunnelRegistry, E2E_KEY_LEN, sanitizePeerText } from '@pooriaarab/vibe-core';
import { decryptAnnotationText } from '../annotationsCrypto.js';
import { decryptChatText } from '../presenceChatCrypto.js';
import { clearActiveShare } from '../consent.js';
import { resolveIceServersConfig, resolveSignaling, resolveTunnel } from '../config.js';
import { HostControlServer } from '../hostControl.js';
import { LocalHttpTransport } from '../localHttp.js';
import type { ShareManager } from '../manager.js';
import type { CreatedShare } from '../manager.js';
import type { ShareTransport } from '../transport.js';
import { WebRtcTransport } from '../webrtc/transport.js';
import { WsSignaling } from '../webrtc/wsSignaling.js';
import type { ShareFlags } from './parse.js';
import type { PrinterBag } from './printers.js';
import type { IO } from './runtimeTypes.js';
import { getShutdownRef } from './shutdown.js';

export type TransportCtx = {
  transport: ShareTransport;
  localHttp: LocalHttpTransport | null;
  publicSignaling: WsSignaling | null;
  hostControl: HostControlServer | null;
  publicShareKey: { value: Buffer | null };
  createdRef: { value: CreatedShare | null };
};

type PublicOpts = {
  options: ShareFlags;
  io: IO;
  printers: PrinterBag;
  createdRef: { value: CreatedShare | null };
  publicShareKey: { value: Buffer | null };
};

export async function setupPublicTransport(opts: PublicOpts): Promise<TransportCtx> {
  const { options, io, printers, createdRef, publicShareKey } = opts;
  const signalingUrl = resolveSignaling(options.signaling);
  const bindPresence = (frame: { viewers: ReadonlyArray<{ viewerId: string; name: string; role: string }> }): void => {
    const created = createdRef.value;
    if (!created) return;
    for (const row of frame.viewers) {
      if (row.role === 'host') continue;
      if (row.viewerId === 'host') continue;
      created.viewers.ensure(row.viewerId, row.name);
    }
  };
  const publicSignaling = new WsSignaling({
    url: signalingUrl,
    onError: (e) => io.err(`[vibeshare] signaling: ${e.message}`),
    onPresence: bindPresence,
    onChat: (frame) => {
      const key = publicShareKey.value;
      if (!key) return;
      const plain = decryptChatText(key, frame.text);
      if (plain) printers.printChat(frame.name, plain);
    },
    onAnnotation: (frame) => {
      const key = publicShareKey.value;
      if (!key) return;
      const plain = decryptAnnotationText(key, frame.text);
      if (plain) printers.printAnnotation(frame.name, frame.seq, plain);
    },
    onJoinRequest: (frame) => {
      const created = createdRef.value;
      if (!created) return;
      try {
        const v = created.viewers.ensure(frame.viewerId, frame.name);
        created.viewers.requestJoin(v.id);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        io.err(`\r\x1b[2m[join] ${sanitizePeerText(frame.name, 32) || 'viewer'}: ${msg}\x1b[0m`);
      }
    },
  });
  const transport = new WebRtcTransport({
    signaling: publicSignaling,
    iceServers: resolveIceServersConfig(options.iceServers, (m) => io.err(`[vibeshare] ${m}`)),
    baseUrl: signalingUrl.replace(/^ws/, 'http'),
    onInput: (_shareId, _viewerId, data) => printers.applyInput(data),
  });
  const hostControl = new HostControlServer({ onStopRequested: () => { getShutdownRef()?.(0); } });
  await hostControl.listen();
  return { transport, localHttp: null, publicSignaling, hostControl, publicShareKey, createdRef };
}

type TunnelOpts = { options: ShareFlags; printers: PrinterBag };

export function setupTunnelTransport(opts: TunnelOpts): TransportCtx {
  const { options, printers } = opts;
  const e2eKey = randomBytes(E2E_KEY_LEN);
  const localHttp = new LocalHttpTransport({
    host: '127.0.0.1',
    port: options.port,
    e2e: { key: e2eKey },
    onChat: (_shareId, frame) => printers.printChat(frame.name, frame.text),
    onAnnotation: (_shareId, frame) => printers.printAnnotation(frame.name, frame.seq, frame.text),
    onInput: (_shareId, _viewerId, data) => printers.applyInput(data),
    onJoinRequest: printers.printJoinRequest,
    onStopRequested: () => { getShutdownRef()?.(0); },
  });
  return { transport: localHttp, localHttp, publicSignaling: null, hostControl: null, publicShareKey: { value: null }, createdRef: { value: null } };
}

type LocalOpts = { options: ShareFlags; printers: PrinterBag };

export function setupLocalTransport(opts: LocalOpts): TransportCtx {
  const { options, printers } = opts;
  const localHttp = new LocalHttpTransport({
    host: options.host,
    port: options.port,
    onChat: (_shareId, frame) => printers.printChat(frame.name, frame.text),
    onAnnotation: (_shareId, frame) => printers.printAnnotation(frame.name, frame.seq, frame.text),
    onInput: (_shareId, _viewerId, data) => printers.applyInput(data),
    onJoinRequest: printers.printJoinRequest,
    onStopRequested: () => { getShutdownRef()?.(0); },
  });
  return { transport: localHttp, localHttp, publicSignaling: null, hostControl: null, publicShareKey: { value: null }, createdRef: { value: null } };
}

type BuildOpts = {
  options: ShareFlags;
  io: IO;
  printers: PrinterBag;
  createdRef: { value: CreatedShare | null };
  publicShareKey: { value: Buffer | null };
};

export async function buildTransport(opts: BuildOpts): Promise<TransportCtx> {
  const tunnelOn = opts.options.tunnel !== false;
  if (opts.options.public) return setupPublicTransport(opts);
  if (tunnelOn) return setupTunnelTransport({ options: opts.options, printers: opts.printers });
  return setupLocalTransport({ options: opts.options, printers: opts.printers });
}

type PostCreateOpts = { created: CreatedShare; ctx: TransportCtx; printers: PrinterBag };

export function handlePublicPostCreate(opts: PostCreateOpts): void {
  const { created, ctx, printers } = opts;
  if (!ctx.publicSignaling) return;
  const hashIdx = created.url.indexOf('#');
  const frag = hashIdx >= 0 ? created.url.slice(hashIdx + 1) : '';
  if (frag) {
    try { ctx.publicShareKey.value = Buffer.from(frag, 'base64url'); } catch { ctx.publicShareKey.value = null; }
  }
  ctx.publicSignaling.setHostName(created.share.id, created.share.name || 'host');
  if (ctx.hostControl) ctx.hostControl.track({ id: created.share.id, viewers: created.viewers });
  const shareId = created.share.id;
  const signaling = ctx.publicSignaling;
  created.viewers.on('request', (v) => printers.printJoinRequest(shareId, v));
  created.viewers.on('approve', (v) => {
    signaling.sendRoleUpdate(shareId, { viewerId: v.id, role: 'collaborator', joinRequest: 'approved' });
  });
  created.viewers.on('deny', (v) => {
    signaling.sendRoleUpdate(shareId, { viewerId: v.id, role: 'spectator', joinRequest: 'denied' });
  });
}

export class TunnelSetupError extends Error {
  constructor() { super('tunnel failed'); this.name = 'TunnelSetupError'; }
}

type TunnelNeededOpts = {
  ctx: TransportCtx;
  options: ShareFlags;
  created: CreatedShare;
  watcher: { stop(): void };
  manager: ShareManager;
  io: IO;
};

export async function setupTunnelIfNeeded(opts: TunnelNeededOpts): Promise<{ created: CreatedShare; tunnelHandle: { url: string; stop(): Promise<void> } | null; tunnelProviderName: string | null }> {
  const tunnelOn = opts.options.tunnel !== false;
  if (!tunnelOn || !opts.ctx.localHttp) return { created: opts.created, tunnelHandle: null, tunnelProviderName: null };
  try {
    const tunnelOpt = opts.options.tunnel === true ? true : typeof opts.options.tunnel === 'string' ? opts.options.tunnel : undefined;
    const resolved = resolveTunnel(tunnelOpt);
    const registry = opts.options.tunnelRegistry ?? createTunnelRegistry();
    const provider = await registry.resolve(resolved.provider);
    const tunnelProviderName = provider.name;
    const localUrl = new URL(opts.created.url.replace(/#.*$/, ''));
    const fragIdx = opts.created.url.indexOf('#');
    const fragment = fragIdx >= 0 ? opts.created.url.slice(fragIdx + 1) : '';
    const tunnelHandle = await provider.start(opts.ctx.localHttp.port, resolved.startOpts);
    const publicBase = tunnelHandle.url.replace(/\/$/, '');
    const publicShareUrl = `${publicBase}${localUrl.pathname}${fragment ? `#${fragment}` : ''}`;
    const nextCreated = { ...opts.created, url: publicShareUrl };
    return { created: nextCreated, tunnelHandle, tunnelProviderName };
  } catch (err) {
    opts.watcher.stop();
    clearActiveShare(opts.created.share.id);
    await opts.manager.stopAll();
    const msg = err instanceof Error ? err.message : String(err);
    opts.io.err(`vibeshare: tunnel failed: ${msg}`);
    throw new TunnelSetupError();
  }
}
