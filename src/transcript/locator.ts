import { readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { TranscriptAgent } from './types.js';

export interface TranscriptLocator {
  locate(cwd: string): string | null;
}

function claudeSlug(cwd: string): string {
  return cwd.replaceAll('/', '-');
}

function locateClaude(cwd: string): string | null {
  const slug = claudeSlug(cwd);
  const roots = [
    join(homedir(), '.claude', 'projects', slug),
    join(homedir(), '.claude-personal', 'projects', slug),
  ];
  let newest: { path: string; mtimeMs: number } | null = null;
  for (const root of roots) {
    let entries;
    try {
      entries = readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      const path = join(root, entry.name);
      try {
        const mtimeMs = statSync(path).mtimeMs;
        if (newest === null || mtimeMs > newest.mtimeMs) newest = { path, mtimeMs };
      } catch {
        // A transcript can disappear while Claude rotates its files.
      }
    }
  }
  return newest?.path ?? null;
}

const nullLocator: TranscriptLocator = { locate: () => null };

/** Per-agent registry; adding Codex later only needs a locator/parser module. */
export const transcriptLocators: Record<TranscriptAgent, TranscriptLocator> = {
  claude: { locate: locateClaude },
  codex: nullLocator,
};

export function locateTranscript(agent: TranscriptAgent, cwd: string): string | null {
  return transcriptLocators[agent].locate(cwd);
}
