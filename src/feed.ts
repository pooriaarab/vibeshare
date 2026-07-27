/**
 * SessionFeed — the ordered log of everything a share broadcasts.
 *
 * The host (and only the host) publishes; spectators subscribe. Late joiners
 * get a bounded replay of recent entries, then live entries in order. This is
 * vibeshare's half of vibelive's "ordered-log channel": the log is the source
 * of record, held on the host machine only.
 */
import { EventEmitter } from 'node:events';
import type { VibeEvent } from '@pooriaarab/vibe-core';
import type { FeedEntry } from './types.js';

export interface PublishOptions {
  readonly type?: FeedEntry['type'];
  readonly stream?: FeedEntry['stream'];
}

export declare interface SessionFeed {
  on(event: 'entry', listener: (entry: FeedEntry) => void): this;
  on(event: 'close', listener: () => void): this;
  once(event: 'close', listener: () => void): this;
}

export class SessionFeed extends EventEmitter {
  readonly #capacity: number;
  #seq = 0;
  #log: FeedEntry[] = [];
  #closed = false;

  constructor(capacity = 1000) {
    super();
    this.#capacity = Math.max(1, capacity);
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** Append a line to the log and fan it out to subscribers. */
  publish(text: string, opts: PublishOptions = {}): FeedEntry {
    if (this.#closed) throw new Error('feed is closed');
    const entry: FeedEntry = {
      seq: ++this.#seq,
      ts: Date.now(),
      type: opts.type ?? 'output',
      ...(opts.stream !== undefined ? { stream: opts.stream } : {}),
      text,
    };
    this.#log.push(entry);
    if (this.#log.length > this.#capacity) {
      this.#log.splice(0, this.#log.length - this.#capacity);
    }
    this.emit('entry', entry);
    return entry;
  }

  /** Publish a normalized vibe-core milestone event as a feed line. */
  publishEvent(e: VibeEvent): FeedEntry {
    const detail = typeof e.payload?.['detail'] === 'string' ? ` — ${e.payload['detail']}` : '';
    return this.publish(`◆ ${e.kind} · ${e.agent}${detail}`, { type: 'milestone' });
  }

  /** Publish a host-side status line (share opened, viewer joined, …). */
  system(text: string): FeedEntry {
    return this.publish(text, { type: 'system' });
  }

  /** Recent entries for late-joiner replay, oldest first. */
  backlog(): readonly FeedEntry[] {
    return this.#log;
  }

  /** Subscribe to live entries. Returns an unsubscribe function. */
  subscribe(listener: (entry: FeedEntry) => void): () => void {
    this.on('entry', listener);
    return () => {
      this.off('entry', listener);
    };
  }

  /** End the feed: notifies subscribers, refuses further publishes. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.emit('close');
    this.removeAllListeners();
  }
}
