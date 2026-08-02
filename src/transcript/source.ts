import { watch, watchFile, unwatchFile, type FSWatcher } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import type { CaptureFeed, CaptureHandle, CaptureSource } from '../capture.js';
import { locateTranscript } from './locator.js';
import { parseLine } from './parse.js';
import { eventToAnsi } from './render.js';
import type { TranscriptAgent } from './types.js';

export interface TranscriptSourceOptions {
  agent: TranscriptAgent;
  cwd: string;
  cols?: number;
  rows?: number;
}

/** A read-only CaptureSource backed by a native harness transcript file. */
export function createTranscriptCaptureSource(opts: TranscriptSourceOptions): CaptureSource {
  return {
    async start(feed: CaptureFeed): Promise<CaptureHandle> {
      const file = locateTranscript(opts.agent, opts.cwd);
      if (!file) throw new Error(`no ${opts.agent} session found for ${opts.cwd}`);

      let stopped = false;
      let offset = 0;
      let sequence = 1;
      let partial = Buffer.alloc(0);
      let watcher: FSWatcher | null = null;
      let polling = false;
      let timer: NodeJS.Timeout | null = null;
      let reading: Promise<void> | null = null;

      try {
        feed.publishResize(opts.cols ?? 100, opts.rows ?? 30);
      } catch {
        // A feed can close between source creation and its first resize.
      }

      const publishBytes = (bytes: Buffer): void => {
        if (stopped || bytes.length === 0) return;
        partial = Buffer.concat([partial, bytes]);
        let newline = partial.indexOf(0x0a);
        while (newline !== -1) {
          let lineBytes = partial.subarray(0, newline);
          if (lineBytes.at(-1) === 0x0d) lineBytes = lineBytes.subarray(0, lineBytes.length - 1);
          partial = partial.subarray(newline + 1);
          const events = parseLine(opts.agent, lineBytes.toString('utf8'), sequence);
          sequence += events.length;
          for (const event of events) {
            if (stopped) return;
            try {
              feed.publishRaw(eventToAnsi(event));
            } catch {
              // The share may have been stopped while a filesystem event was queued.
            }
          }
          newline = partial.indexOf(0x0a);
        }
      };

      const readGrowth = async (): Promise<void> => {
        if (stopped || reading) return;
        reading = (async () => {
          const current = await stat(file);
          if (current.size < offset) {
            offset = 0;
            partial = Buffer.alloc(0);
          }
          if (current.size === offset) return;
          const handle = await open(file, 'r');
          try {
            const length = current.size - offset;
            const bytes = Buffer.alloc(length);
            const result = await handle.read(bytes, 0, length, offset);
            offset += result.bytesRead;
            publishBytes(bytes.subarray(0, result.bytesRead));
          } finally {
            await handle.close();
          }
        })().catch(() => {
          // The harness may rotate the file between stat and open; the next event retries.
        }).finally(() => {
          reading = null;
        });
        await reading;
      };

      const scheduleRead = (): void => {
        if (stopped || timer) return;
        timer = setTimeout(() => {
          timer = null;
          void readGrowth();
        }, 50);
        timer.unref?.();
      };

      const pollListener = (): void => scheduleRead();
      const usePolling = (): void => {
        if (polling || stopped) return;
        polling = true;
        watcher?.close();
        watcher = null;
        watchFile(file, { interval: 500, persistent: false }, pollListener);
      };

      await readGrowth();
      try {
        watcher = watch(file, { persistent: false }, scheduleRead);
        watcher.on('error', usePolling);
        // Some filesystems report an fs.watch event before the append is
        // readable, or do not report it at all. Keep the low-frequency poll
        // armed as the fallback while fs.watch handles the fast path.
        polling = true;
        watchFile(file, { interval: 500, persistent: false }, pollListener);
      } catch {
        usePolling();
      }

      return {
        label: `${opts.agent} · ${basename(opts.cwd)}`,
        stop: async () => {
          if (stopped) return;
          stopped = true;
          if (timer) clearTimeout(timer);
          timer = null;
          watcher?.close();
          watcher = null;
          if (polling) unwatchFile(file, pollListener);
          if (reading) await reading.catch(() => undefined);
        },
      };
    },
  };
}
