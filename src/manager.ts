/**
 * ShareManager — creates, tracks, expires, and revokes shares.
 *
 * The consent ledger from @pooriaarab/vibe-core is the enforcement point for
 * local-first: no grant for the `share:session` scope → no share. Expiry is
 * enforced here with real timers that tear the share down (the transport
 * disconnects viewers and the URL goes 410) — not just a filter on reads.
 */
import type { ConsentLedger } from '@pooriaarab/vibe-core';
import { SessionFeed } from './feed.js';
import { ViewerRegistry } from './registry.js';
import type { ShareTransport } from './transport.js';
import {
  ShareError,
  type CreateShareOptions,
  type Share,
  type ShareAccess,
} from './types.js';
import { hashPassphrase, newShareId, parseExpiry } from './utils.js';

/** The consent scope the suite reserves for sharing features. */
export const SHARE_SCOPE = 'share:session';

export class ConsentRequiredError extends ShareError {
  constructor() {
    super(
      'consent-required',
      `sharing requires a "${SHARE_SCOPE}" consent grant — run \`vibeshare\` interactively to grant it, or call consent.grant("${SHARE_SCOPE}")`,
    );
    this.name = 'ConsentRequiredError';
  }
}

export interface CreatedShare {
  readonly share: Share;
  /** The URL viewers open. */
  readonly url: string;
  readonly feed: SessionFeed;
  readonly viewers: ViewerRegistry;
  /** End the share now (same as manager.revokeShare(share.id)). */
  revoke(): Promise<void>;
}

export interface ShareManagerDeps {
  readonly consent: ConsentLedger;
  readonly transport: ShareTransport;
}

export class ShareManager {
  readonly #consent: ConsentLedger;
  readonly #transport: ShareTransport;
  readonly #live = new Map<string, CreatedShare>();
  readonly #timers = new Map<string, NodeJS.Timeout>();

  constructor(deps: ShareManagerDeps) {
    this.#consent = deps.consent;
    this.#transport = deps.transport;
  }

  /**
   * Create a share: `createShare({session, access, expiry, passphrase})`
   * → `{share, url, feed, viewers, revoke}`.
   *
   * @throws ConsentRequiredError when the ledger has no `share:session` grant.
   */
  async createShare(opts: CreateShareOptions = {}): Promise<CreatedShare> {
    if (!this.#consent.allows(SHARE_SCOPE)) throw new ConsentRequiredError();

    const access: ShareAccess = opts.access ?? 'spectate';
    const expiryMs = opts.expiryMs ?? parseExpiry(opts.expiry ?? 'stop');
    const now = Date.now();
    const share: Share = {
      id: newShareId(),
      name: opts.name ?? opts.session ?? 'agent session',
      access,
      createdAt: new Date(now).toISOString(),
      expiresAt: expiryMs === null ? null : new Date(now + expiryMs).toISOString(),
      state: 'live',
      passphraseHash:
        opts.passphrase !== undefined && opts.passphrase.length > 0
          ? hashPassphrase(opts.passphrase)
          : null,
    };

    const feed = new SessionFeed();
    const viewers = new ViewerRegistry(() => share.access);
    const url = await this.#transport.serve(share, feed, viewers);

    const created: CreatedShare = {
      share,
      url,
      feed,
      viewers,
      revoke: () => this.revokeShare(share.id),
    };
    this.#live.set(share.id, created);

    if (expiryMs !== null) {
      const timer = setTimeout(() => {
        void this.revokeShare(share.id, 'expired');
      }, expiryMs);
      // Never hold the process open just for an expiry timer.
      timer.unref?.();
      this.#timers.set(share.id, timer);
    }

    feed.system(`share opened · access=${access} · ${share.expiresAt ?? 'until stopped'}`);
    return created;
  }

  /** End a share: disconnect viewers, 410 the URL, close the feed. */
  async revokeShare(id: string, reason: 'revoked' | 'expired' = 'revoked'): Promise<void> {
    const created = this.#live.get(id);
    if (!created) return;
    created.share.state = reason;
    const timer = this.#timers.get(id);
    if (timer) clearTimeout(timer);
    this.#timers.delete(id);
    this.#live.delete(id);
    await this.#transport.unserve(id);
    // A transport-level stop may have closed the feed already.
    if (!created.feed.closed) {
      created.feed.system(`share ${reason}`);
      created.feed.close();
    }
  }

  get(id: string): CreatedShare | undefined {
    return this.#live.get(id);
  }

  list(): CreatedShare[] {
    return [...this.#live.values()];
  }

  /** Revoke every live share and close the transport. */
  async stopAll(): Promise<void> {
    for (const id of [...this.#live.keys()]) {
      await this.revokeShare(id);
    }
    await this.#transport.close();
  }
}
