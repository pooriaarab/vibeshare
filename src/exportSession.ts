/**
 * Pure session-export helpers (no DOM, no transport).
 *
 * Browser pages call tiny inlined equivalents for Blob downloads; this module
 * is the unit-tested source of truth for formats that are pure data (asciinema
 * cast serialization). Live cast *recording* of viewer frames is intentionally
 * not wired yet — see TODO below.
 */

/** asciinema v2 header (first line of a .cast file). */
export interface AsciinemaCastHeader {
  readonly version: 2;
  readonly width: number;
  readonly height: number;
  readonly timestamp?: number;
  readonly title?: string;
  readonly env?: Readonly<Record<string, string>>;
}

/**
 * One asciinema v2 event: `[timeSec, type, data]`.
 * type `o` = output (PTY → viewer), `i` = input (viewer → PTY).
 */
export type AsciinemaCastEvent = readonly [number, 'o' | 'i', string];

function validateCastHeader(header: AsciinemaCastHeader): void {
  if (header.version !== 2) {
    throw new Error(`unsupported asciinema cast version: ${String(header.version)}`);
  }
  if (!Number.isFinite(header.width) || header.width < 1) {
    throw new Error('cast width must be a positive number');
  }
  if (!Number.isFinite(header.height) || header.height < 1) {
    throw new Error('cast height must be a positive number');
  }
}

/** Validate one event and return the exact triple that gets serialized. */
function validateCastEvent(ev: AsciinemaCastEvent): AsciinemaCastEvent {
  if (!Array.isArray(ev) || ev.length !== 3) {
    throw new Error('cast event must be [time, type, data]');
  }
  const [t, type, data] = ev;
  if (!Number.isFinite(t) || t < 0) {
    throw new Error('cast event time must be a non-negative number');
  }
  if (type !== 'o' && type !== 'i') {
    throw new Error(`cast event type must be "o" or "i", got ${String(type)}`);
  }
  if (typeof data !== 'string') {
    throw new Error('cast event data must be a string');
  }
  // Serialize the destructured triple, never `ev` itself: a caller-supplied
  // array subclass or a `toJSON` on it would otherwise change the cast bytes.
  return [t, type, data];
}

function serializeCastEvent(ev: AsciinemaCastEvent): string {
  return JSON.stringify(validateCastEvent(ev));
}

/**
 * Serialize an asciinema v2 cast (JSON lines).
 * https://docs.asciinema.org/manual/asciicast/v2/
 */
export function serializeAsciinemaCast(
  header: AsciinemaCastHeader,
  events: readonly AsciinemaCastEvent[] = [],
): string {
  validateCastHeader(header);
  const lines: string[] = [JSON.stringify(header)];
  for (const ev of events) {
    lines.push(serializeCastEvent(ev));
  }
  return lines.join('\n') + '\n';
}

/**
 * Join xterm buffer line strings into a plain-text transcript.
 * Trims trailing all-empty lines but preserves interior blanks.
 */
export function joinBufferLines(lines: readonly string[]): string {
  const copy = lines.map((l) => (typeof l === 'string' ? l.replace(/\s+$/g, '') : ''));
  let end = copy.length;
  while (end > 0 && copy[end - 1] === '') end--;
  return copy.slice(0, end).join('\n');
}

/**
 * TODO(export-cast-recording): optionally record raw byte frames the viewer
 * receives (with timestamps) and download via `serializeAsciinemaCast`. Needs
 * a hook next to `__vsHandleEntry` / `applyEntry` without touching transport.
 * Snapshot-from-buffer is enough for PNG/text; live .cast is deferred.
 */
