import { describe, expect, it } from 'vitest';
import { parseLine } from '../src/transcript/parse.js';

describe('parseLine', () => {
  it('normalizes Claude user and assistant blocks with monotonic sequences', () => {
    const user = parseLine(
      'claude',
      JSON.stringify({ type: 'user', message: { content: 'Please inspect the app' } }),
      7,
    );
    const userBlocks = parseLine(
      'claude',
      JSON.stringify({
        type: 'user',
        message: {
          content: [
            { type: 'text', text: 'Use API_KEY=do-not-share' },
            { type: 'tool_result', content: 'result: sk-ant-api03-secret-value' },
          ],
        },
      }),
      8,
    );
    const assistant = parseLine(
      'claude',
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'I found the issue.' },
            { type: 'thinking', thinking: 'I should check the configuration.' },
            { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { path: 'src/index.ts' } },
          ],
        },
      }),
      10,
    );

    expect([...user, ...userBlocks, ...assistant]).toEqual([
      {
        seq: 7,
        role: 'user',
        kind: 'prompt',
        text: 'Please inspect the app',
        agent: 'claude',
      },
      {
        seq: 8,
        role: 'user',
        kind: 'prompt',
        text: 'Use API_KEY=«redacted:‹secret›»',
        agent: 'claude',
      },
      {
        seq: 9,
        role: 'tool',
        kind: 'tool_result',
        text: 'result: «redacted:‹api-key›»',
        agent: 'claude',
      },
      {
        seq: 10,
        role: 'assistant',
        kind: 'response',
        text: 'I found the issue.',
        agent: 'claude',
      },
      {
        seq: 11,
        role: 'assistant',
        kind: 'thinking',
        text: 'I should check the configuration.',
        agent: 'claude',
      },
      {
        seq: 12,
        role: 'assistant',
        kind: 'tool_use',
        text: '',
        tool: { name: 'Read', input: '{"path":"src/index.ts"}' },
        agent: 'claude',
      },
    ]);
  });

  it('ignores Claude metadata and malformed trailing lines', () => {
    expect(parseLine('claude', JSON.stringify({ type: 'ai-title', title: 'noise' }), 1)).toEqual([]);
    expect(parseLine('claude', '{"type":"assistant"', 1)).toEqual([]);
  });
});
