import type { TranscriptEvent } from './types.js';

const RESET = '\x1b[0m';
const DIM = '\x1b[2m';

function terminalText(text: string): string {
  return text
    .replaceAll('\x1b', '\\x1b')
    .replace(/\r\n|\n/g, '\n')
    .replaceAll('\r', '\\r')
    .replaceAll('\n', '\r\n');
}

function line(label: string, text: string): string {
  return `${label}\r\n${terminalText(text)}\r\n`;
}

function renderPrompt(event: TranscriptEvent): string {
  return line('\x1b[1;36m▸ you\x1b[0m', event.text);
}

function renderResponse(event: TranscriptEvent): string {
  return line('\x1b[32m● claude\x1b[0m', event.text);
}

function renderThinking(event: TranscriptEvent): string {
  return line(`${DIM}\x1b[3m… thinking${RESET}`, event.text);
}

function renderToolUse(event: TranscriptEvent): string {
  const name = terminalText(event.tool?.name ?? 'tool');
  const input = event.tool?.input === undefined ? '' : ` ${DIM}${terminalText(event.tool.input)}${RESET}`;
  return line(`\x1b[33m⚙ ${name}${RESET}${input}`, event.text);
}

function renderToolResult(event: TranscriptEvent): string {
  return line(`${DIM}↳ tool result${RESET}`, event.text);
}

function renderSystem(event: TranscriptEvent): string {
  return line(`${DIM}· system${RESET}`, event.text);
}

const ansiRenderers: Record<TranscriptEvent['kind'], (event: TranscriptEvent) => string> = {
  prompt: renderPrompt,
  response: renderResponse,
  thinking: renderThinking,
  tool_use: renderToolUse,
  tool_result: renderToolResult,
  system: renderSystem,
};

/** Render one normalized event as readable xterm-compatible ANSI. */
export function eventToAnsi(event: TranscriptEvent): string {
  const key = event.kind;
  const table = ansiRenderers as Record<string, (event: TranscriptEvent) => string>;
  const fn = Object.hasOwn(ansiRenderers, key) ? table[key] : undefined;
  if (fn) return fn(event);
  return '';
}
