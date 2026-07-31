/**
 * ViewerRegistry — who is watching a share, and who may write.
 *
 * Write-arbitration invariant (shared with vibelive §4): the host is the
 * server of record, and `canWrite()` is the single gate any input path must
 * consult. A spectator can never pass it; promotion happens only through a
 * host-approved join request on an `invite`-access share. v0 exposes no
 * remote input route at all — the gate exists so the vibelive handoff has
 * exactly one choke point when it lands.
 */
import { EventEmitter } from 'node:events';
import { sanitizePeerText } from '@pooriaarab/vibe-core';
import { ShareError, type ShareAccess, type Viewer } from './types.js';
import { newShareId, newToken } from './utils.js';

export interface RegistryEvents {
  join: (v: Viewer) => void;
  leave: (v: Viewer) => void;
  request: (v: Viewer) => void;
  approve: (v: Viewer) => void;
  deny: (v: Viewer) => void;
  kick: (v: Viewer) => void;
}

export declare interface ViewerRegistry {
  on<K extends keyof RegistryEvents>(event: K, listener: RegistryEvents[K]): this;
}

export class ViewerRegistry extends EventEmitter {
  readonly #getAccess: () => ShareAccess;
  readonly #viewers = new Map<string, Viewer>();

  constructor(getAccess: () => ShareAccess) {
    super();
    this.#getAccess = getAccess;
  }

  /** Register a new spectator. Everyone enters read-only — no exceptions. */
  add(name?: string): Viewer {
    const viewer: Viewer = {
      id: newShareId(),
      name: sanitizeName(name),
      role: 'spectator',
      token: newToken(),
      joinedAt: new Date().toISOString(),
      joinRequest: 'none',
    };
    this.#viewers.set(viewer.id, viewer);
    this.emit('join', viewer);
    return viewer;
  }

  get(id: string): Viewer | undefined {
    return this.#viewers.get(id);
  }

  getByToken(token: string): Viewer | undefined {
    for (const v of this.#viewers.values()) {
      if (v.token === token) return v;
    }
    return undefined;
  }

  list(): Viewer[] {
    return [...this.#viewers.values()];
  }

  count(): number {
    return this.#viewers.size;
  }

  /**
   * A spectator asks to be promoted to collaborator. Only possible on an
   * `invite`-access share; the host still has to approve.
   */
  requestJoin(id: string): Viewer {
    const v = this.#mustGet(id);
    if (this.#getAccess() !== 'invite') {
      throw new ShareError('invite-disabled', 'this share is spectate-only');
    }
    if (v.joinRequest === 'pending') {
      throw new ShareError('already-pending', 'join request already pending');
    }
    if (v.role === 'collaborator') return v;
    v.joinRequest = 'pending';
    this.emit('request', v);
    return v;
  }

  /** Host approves a pending request → the viewer becomes a collaborator. */
  approve(id: string): Viewer {
    const v = this.#mustGet(id);
    if (v.joinRequest !== 'pending') {
      throw new ShareError('not-pending', 'no pending join request from this viewer');
    }
    v.joinRequest = 'approved';
    v.role = 'collaborator';
    this.emit('approve', v);
    return v;
  }

  /** Host denies a pending request; the viewer stays a spectator. */
  deny(id: string): Viewer {
    const v = this.#mustGet(id);
    if (v.joinRequest !== 'pending') {
      throw new ShareError('not-pending', 'no pending join request from this viewer');
    }
    v.joinRequest = 'denied';
    this.emit('deny', v);
    return v;
  }

  /** Remove a viewer entirely (their streams are closed by the transport). */
  kick(id: string): Viewer {
    const v = this.#mustGet(id);
    this.#viewers.delete(id);
    this.emit('kick', v);
    return v;
  }

  /** A viewer leaves on their own. */
  leave(id: string): void {
    const v = this.#viewers.get(id);
    if (!v) return;
    this.#viewers.delete(id);
    this.emit('leave', v);
  }

  /**
   * The write-arbitration gate. The host writes by definition; a remote
   * participant writes only as an approved collaborator. Any future input
   * channel (vibelive cursors, shared terminal input) MUST consult this.
   */
  canWrite(viewerId: string): boolean {
    return this.#viewers.get(viewerId)?.role === 'collaborator';
  }

  #mustGet(id: string): Viewer {
    const v = this.#viewers.get(id);
    if (!v) throw new ShareError('not-found', `no viewer ${id}`);
    return v;
  }
}

function sanitizeName(name: string | undefined): string {
  // Peer-supplied display text — strip terminal/bidi injection before storage.
  const cleaned = sanitizePeerText(name ?? '', 32).trim().slice(0, 32);
  return cleaned.length > 0 ? cleaned : `anon-${newToken(2)}`;
}
