/** Tiny SSE client helpers for transport tests (real HTTP, real streams). */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface SseEvent {
  event: string;
  data: string;
}

/** Parse one `\n\n`-delimited SSE frame into an event, defaulting like the spec. */
function parseSseFrame(raw: string): SseEvent {
  const ev: SseEvent = { event: 'message', data: '' };
  for (const line of raw.split('\n')) {
    if (line.startsWith('event: ')) ev.event = line.slice(7);
    else if (line.startsWith('data: ')) ev.data = line.slice(6);
  }
  return ev;
}

/**
 * Read SSE events from a fetch Response until `done` says stop, the stream
 * ends, or the timeout hits (timeout → throw so failures show what arrived).
 */
export async function readSse(
  res: Response,
  done: (events: SseEvent[]) => boolean,
  timeoutMs = 6000,
): Promise<SseEvent[]> {
  const body = res.body;
  if (body === null) throw new Error('readSse: response has no body to read');
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const events: SseEvent[] = [];
  const deadline = Date.now() + timeoutMs;
  try {
    while (!done(events)) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`readSse timed out with ${JSON.stringify(events)}`);
      const { done: ended, value } = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('readSse read timeout')), remaining)),
      ]);
      if (ended) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        events.push(parseSseFrame(raw));
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return events;
}

/** Wait until the stream closes on its own (e.g. after kick/ended). */
export async function readSseUntilClose(res: Response, timeoutMs = 6000): Promise<SseEvent[]> {
  return readSse(res, () => false, timeoutMs).catch(() => {
    throw new Error('stream did not close in time');
  });
}

export function tempHome(): { dir: string; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), 'vibeshare-test-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
