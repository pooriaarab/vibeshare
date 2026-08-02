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

/** Render one normalized event as readable xterm-compatible ANSI. */
export function eventToAnsi(event: TranscriptEvent): string {
  switch (event.kind) {
    case 'prompt':
      return line('\x1b[1;36m▸ you\x1b[0m', event.text);
    case 'response':
      return line('\x1b[32m● claude\x1b[0m', event.text);
    case 'thinking':
      return line(`${DIM}\x1b[3m… thinking${RESET}`, event.text);
    case 'tool_use': {
      const name = terminalText(event.tool?.name ?? 'tool');
      const input = event.tool?.input === undefined ? '' : ` ${DIM}${terminalText(event.tool.input)}${RESET}`;
      return line(`\x1b[33m⚙ ${name}${RESET}${input}`, event.text);
    }
    case 'tool_result':
      return line(`${DIM}↳ tool result${RESET}`, event.text);
    case 'system':
      return line(`${DIM}· system${RESET}`, event.text);
  }
}
