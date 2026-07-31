/**
 * SessionFeed — the ordered log of everything a share broadcasts.
 *
 * The host (and only the host) publishes; spectators subscribe. Late joiners
 * get a bounded replay of recent entries, then live entries in order. This is
 * vibeshare's half of vibelive's "ordered-log channel": the log is the source
 * of record, held on the host machine only.
 *
 * Session output is carried as ordered raw PTY bytes (`type: 'raw'`) plus
 * terminal `resize` events so a viewer-side emulator can reconstruct the
 * real TUI. Structured milestone/system lines remain for chrome.
 */
import { EventEmitter } from 'node:events';
import type { VibeEvent } from '@pooriaarab/vibe-core';
import type { FeedEntry } from './types.js';

export interface PublishOptions {
  readonly type?: Extract<FeedEntry, { text: string }>['type'];
  readonly stream?: 'stdout' | 'stderr';
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

  /** Append a structured line to the log and fan it out to subscribers. */
  publish(text: string, opts: PublishOptions = {}): FeedEntry {
    if (this.#closed) throw new Error('feed is closed');
    const entry: FeedEntry = {
      seq: ++this.#seq,
      ts: Date.now(),
      type: opts.type ?? 'output',
      ...(opts.stream !== undefined ? { stream: opts.stream } : {}),
      text,
    };
    return this.#append(entry);
  }

  /**
   * Publish raw PTY/terminal bytes. Viewers base64-decode and feed an
   * emulator (`term.write`) so colors/cursor/full-screen redraws render.
   */
  publishRaw(data: string | Buffer | Uint8Array): FeedEntry {
    if (this.#closed) throw new Error('feed is closed');
    const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data);
    const entry: FeedEntry = {
      seq: ++this.#seq,
      ts: Date.now(),
      type: 'raw',
      data: buf.toString('base64'),
    };
    return this.#append(entry);
  }

  /** Publish a host terminal size so viewers can `term.resize(cols, rows)`. */
  publishResize(cols: number, rows: number): FeedEntry {
    if (this.#closed) throw new Error('feed is closed');
    const entry: FeedEntry = {
      seq: ++this.#seq,
      ts: Date.now(),
      type: 'resize',
      cols: Math.max(1, Math.floor(cols)),
      rows: Math.max(1, Math.floor(rows)),
    };
    return this.#append(entry);
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

  #append(entry: FeedEntry): FeedEntry {
    this.#log.push(entry);
    if (this.#log.length > this.#capacity) {
      this.#log.splice(0, this.#log.length - this.#capacity);
    }
    this.emit('entry', entry);
    return entry;
  }
}
