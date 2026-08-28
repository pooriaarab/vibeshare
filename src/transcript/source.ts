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

interface CaptureState {
  file: string;
  opts: TranscriptSourceOptions;
  feed: CaptureFeed;
  stopped: boolean;
  offset: number;
  sequence: number;
  partial: Buffer;
  watcher: FSWatcher | null;
  polling: boolean;
  timer: NodeJS.Timeout | null;
  reading: Promise<void> | null;
}

function createState(file: string, opts: TranscriptSourceOptions, feed: CaptureFeed): CaptureState {
  return {
    file,
    opts,
    feed,
    stopped: false,
    offset: 0,
    sequence: 1,
    partial: Buffer.alloc(0),
    watcher: null,
    polling: false,
    timer: null,
    reading: null,
  };
}

function publishBytes(state: CaptureState, bytes: Buffer): void {
  if (state.stopped || bytes.length === 0) return;
  state.partial = Buffer.concat([state.partial, bytes]);
  let newline = state.partial.indexOf(0x0a);
  while (newline !== -1) {
    let lineBytes = state.partial.subarray(0, newline);
    if (lineBytes.at(-1) === 0x0d) lineBytes = lineBytes.subarray(0, lineBytes.length - 1);
    state.partial = state.partial.subarray(newline + 1);
    const events = parseLine(state.opts.agent, lineBytes.toString('utf8'), state.sequence);
    state.sequence += events.length;
    for (const event of events) {
      if (state.stopped) return;
      try {
        state.feed.publishRaw(eventToAnsi(event));
      } catch {
        // The share may have been stopped while a filesystem event was queued.
      }
    }
    newline = state.partial.indexOf(0x0a);
  }
}

async function readGrowth(state: CaptureState): Promise<void> {
  if (state.stopped || state.reading) return;
  state.reading = (async () => {
    const current = await stat(state.file);
    if (current.size < state.offset) {
      state.offset = 0;
      state.partial = Buffer.alloc(0);
    }
    if (current.size === state.offset) return;
    const handle = await open(state.file, 'r');
    try {
      const length = current.size - state.offset;
      const bytes = Buffer.alloc(length);
      const result = await handle.read(bytes, 0, length, state.offset);
      state.offset += result.bytesRead;
      publishBytes(state, bytes.subarray(0, result.bytesRead));
    } finally {
      await handle.close();
    }
  })()
    .catch(() => {
      // The harness may rotate the file between stat and open; the next event retries.
    })
    .finally(() => {
      state.reading = null;
    });
  await state.reading;
}

function scheduleRead(state: CaptureState): void {
  if (state.stopped || state.timer) return;
  state.timer = setTimeout(() => {
    state.timer = null;
    void readGrowth(state);
  }, 50);
  state.timer.unref?.();
}

function pollListenerFor(state: CaptureState): () => void {
  return () => scheduleRead(state);
}

function usePolling(state: CaptureState, pollListener: () => void): void {
  if (state.polling || state.stopped) return;
  state.polling = true;
  state.watcher?.close();
  state.watcher = null;
  watchFile(state.file, { interval: 500, persistent: false }, pollListener);
}

function setupWatchers(state: CaptureState): void {
  const pollListener = pollListenerFor(state);
  const pollingFallback = (): void => usePolling(state, pollListener);
  try {
    state.watcher = watch(state.file, { persistent: false }, () => scheduleRead(state));
    state.watcher.on('error', pollingFallback);
    state.polling = true;
    watchFile(state.file, { interval: 500, persistent: false }, pollListener);
  } catch {
    usePolling(state, pollListener);
  }
}

function createHandle(state: CaptureState): CaptureHandle {
  const pollListener = pollListenerFor(state);
  return {
    label: `${state.opts.agent} · ${basename(state.opts.cwd)}`,
    stop: async () => {
      if (state.stopped) return;
      state.stopped = true;
      if (state.timer) clearTimeout(state.timer);
      state.timer = null;
      state.watcher?.close();
      state.watcher = null;
      if (state.polling) unwatchFile(state.file, pollListener);
      if (state.reading) await state.reading.catch(() => undefined);
    },
  };
}

async function startTranscriptCapture(opts: TranscriptSourceOptions, feed: CaptureFeed): Promise<CaptureHandle> {
  const file = locateTranscript(opts.agent, opts.cwd);
  if (!file) throw new Error(`no ${opts.agent} session found for ${opts.cwd}`);
  const state = createState(file, opts, feed);
  try {
    feed.publishResize(opts.cols ?? 100, opts.rows ?? 30);
  } catch {
    // A feed can close between source creation and its first resize.
  }
  await readGrowth(state);
  setupWatchers(state);
  return createHandle(state);
}

/** A read-only CaptureSource backed by a native harness transcript file. */
export function createTranscriptCaptureSource(opts: TranscriptSourceOptions): CaptureSource {
  return {
    start: (feed) => startTranscriptCapture(opts, feed),
  };
}
