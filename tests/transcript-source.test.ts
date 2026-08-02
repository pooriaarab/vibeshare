import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createTranscriptCaptureSource } from '../src/transcript/source.js';
import type { CaptureFeed } from '../src/capture.js';

describe('createTranscriptCaptureSource', () => {
  let home: string | undefined;
  let previousHome: string | undefined;

  afterEach(() => {
    if (previousHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = previousHome;
    if (home) rmSync(home, { recursive: true, force: true });
  });

  it('renders backlog, tails complete appended lines, and stops cleanly', async () => {
    previousHome = process.env['HOME'];
    home = mkdtempSync(join(tmpdir(), 'vibeshare-transcript-home-'));
    process.env['HOME'] = home;

    const cwd = mkdtempSync(join(tmpdir(), 'vibeshare-transcript-cwd-'));
    const slug = cwd.replaceAll('/', '-');
    const projectDir = join(home, '.claude', 'projects', slug);
    mkdirSync(projectDir, { recursive: true });
    const transcript = join(projectDir, 'session.jsonl');
    writeFileSync(
      transcript,
      [
        JSON.stringify({ type: 'user', message: { content: 'hello from backlog' } }),
        JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hello back' }] } }),
      ].join('\n') + '\n',
    );

    const raw: string[] = [];
    const resizes: Array<[number, number]> = [];
    const feed: CaptureFeed = {
      publishRaw(data) {
        raw.push(typeof data === 'string' ? data : Buffer.from(data).toString('utf8'));
      },
      publishResize(cols, rows) {
        resizes.push([cols, rows]);
      },
    };

    const source = createTranscriptCaptureSource({ agent: 'claude', cwd, cols: 120, rows: 40 });
    const handle = await source.start(feed);
    expect(handle.label).toBe(`claude · ${cwd.split('/').pop()}`);
    expect(resizes).toEqual([[120, 40]]);
    expect(raw.join('')).toContain('▸ you');
    expect(raw.join('')).toContain('hello from backlog');
    expect(raw.join('')).toContain('● claude');
    expect(raw.every((chunk) => chunk.includes('\r\n'))).toBe(true);

    appendFileSync(
      transcript,
      JSON.stringify({ type: 'user', message: { content: 'new prompt' } }) + '\n',
    );
    await waitFor(() => raw.join('').includes('new prompt'));

    await handle.stop();
    const countAfterStop = raw.length;
    appendFileSync(
      transcript,
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'after stop' }] } }) + '\n',
    );
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(raw.length).toBe(countAfterStop);
    rmSync(cwd, { recursive: true, force: true });
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for transcript update');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
