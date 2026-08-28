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

function readEntries(root: string): Array<{ isFile(): boolean; name: string }> | undefined {
  try {
    return readdirSync(root, { withFileTypes: true }) as unknown as Array<{ isFile(): boolean; name: string }>;
  } catch {
    return undefined;
  }
}

function statMtime(path: string): number | undefined {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return undefined;
  }
}

function isTranscriptFile(entry: { isFile(): boolean; name: string }): boolean {
  return entry.isFile() && entry.name.endsWith('.jsonl');
}

function pickNewest(
  current: { path: string; mtimeMs: number } | null,
  candidatePath: string,
  candidateMtime: number,
): { path: string; mtimeMs: number } {
  if (current === null || candidateMtime > current.mtimeMs) return { path: candidatePath, mtimeMs: candidateMtime };
  return current;
}

function scanRoot(root: string, newest: { path: string; mtimeMs: number } | null): { path: string; mtimeMs: number } | null {
  const entries = readEntries(root);
  if (entries === undefined) return newest;
  let result = newest;
  for (const entry of entries) {
    if (!isTranscriptFile(entry)) continue;
    const path = join(root, entry.name);
    const mtimeMs = statMtime(path);
    if (mtimeMs === undefined) continue;
    result = pickNewest(result, path, mtimeMs);
  }
  return result;
}

function locateClaude(cwd: string): string | null {
  const slug = claudeSlug(cwd);
  const roots = [join(homedir(), '.claude', 'projects', slug), join(homedir(), '.claude-personal', 'projects', slug)];
  let newest: { path: string; mtimeMs: number } | null = null;
  for (const root of roots) {
    newest = scanRoot(root, newest);
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
