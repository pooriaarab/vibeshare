import { redact } from './redact.js';
import type { TranscriptAgent, TranscriptEvent } from './types.js';

interface JsonRecord {
  [key: string]: unknown;
}

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === 'object' ? value as JsonRecord : null;
}

function contentText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value
      .map((part) => {
        if (typeof part === 'string') return part;
        const block = record(part);
        return typeof block?.['text'] === 'string' ? block['text'] : '';
      })
      .filter(Boolean)
      .join('\n');
  }
  if (value === undefined || value === null) return '';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function timestamp(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function event(
  agent: TranscriptAgent,
  seq: number,
  role: TranscriptEvent['role'],
  kind: TranscriptEvent['kind'],
  text: string,
  ts: number | undefined,
  tool?: TranscriptEvent['tool'],
): TranscriptEvent {
  return {
    seq,
    ...(ts !== undefined ? { ts } : {}),
    role,
    kind,
    text: redact(text),
    ...(tool !== undefined ? { tool } : {}),
    agent,
  };
}

/** Parse one Claude JSONL line. Invalid or unsupported lines are ignored. */
function parseClaudeLine(
  rawJsonLine: string,
  nextSeq: number,
): TranscriptEvent[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJsonLine) as unknown;
  } catch {
    return [];
  }
  const line = record(parsed);
  if (!line || (line['type'] !== 'user' && line['type'] !== 'assistant')) return [];

  const message = record(line['message']);
  if (!message) return [];
  const ts = timestamp(line['timestamp']);
  const events: TranscriptEvent[] = [];
  const add = (
    role: TranscriptEvent['role'],
    kind: TranscriptEvent['kind'],
    text: string,
    tool?: TranscriptEvent['tool'],
  ): void => {
    events.push(event('claude', nextSeq + events.length, role, kind, text, ts, tool));
  };

  if (line['type'] === 'user') {
    const content = message['content'];
    if (typeof content === 'string') {
      add('user', 'prompt', content);
      return events;
    }
    if (!Array.isArray(content)) return events;
    for (const rawBlock of content) {
      const block = record(rawBlock);
      if (!block) continue;
      if (block['type'] === 'text' && typeof block['text'] === 'string') {
        add('user', 'prompt', block['text']);
      } else if (block['type'] === 'tool_result') {
        add('tool', 'tool_result', contentText(block['content']));
      }
    }
    return events;
  }

  const content = message['content'];
  if (!Array.isArray(content)) return events;
  for (const rawBlock of content) {
    const block = record(rawBlock);
    if (!block) continue;
    if (block['type'] === 'text' && typeof block['text'] === 'string') {
      add('assistant', 'response', block['text']);
    } else if (block['type'] === 'thinking' && typeof block['thinking'] === 'string') {
      add('assistant', 'thinking', block['thinking']);
    } else if (block['type'] === 'tool_use' && typeof block['name'] === 'string') {
      let input: string | undefined;
      if (block['input'] !== undefined) {
        try {
          input = redact(JSON.stringify(block['input']));
        } catch {
          input = redact(String(block['input']));
        }
      }
      add('assistant', 'tool_use', '', {
        name: redact(block['name']),
        ...(input !== undefined ? { input } : {}),
      });
    }
  }
  return events;
}

type TranscriptParser = (rawJsonLine: string, nextSeq: number) => TranscriptEvent[];

const transcriptParsers: Record<TranscriptAgent, TranscriptParser> = {
  claude: parseClaudeLine,
  codex: () => [],
};

export function parseLine(
  agent: TranscriptAgent,
  rawJsonLine: string,
  nextSeq: number,
): TranscriptEvent[] {
  return transcriptParsers[agent](rawJsonLine, nextSeq).map((event) => ({ ...event, agent }));
}
