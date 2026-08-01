import { describe, expect, it } from 'vitest';
import {
  joinBufferLines,
  serializeAsciinemaCast,
  type AsciinemaCastEvent,
  type AsciinemaCastHeader,
} from '../src/exportSession.js';

describe('serializeAsciinemaCast', () => {
  const header: AsciinemaCastHeader = {
    version: 2,
    width: 80,
    height: 24,
    title: 'vibeshare',
  };

  it('emits header-only cast with trailing newline', () => {
    const cast = serializeAsciinemaCast(header);
    expect(cast.endsWith('\n')).toBe(true);
    const lines = cast.trimEnd().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toEqual(header);
  });

  it('emits JSON-lines events after the header', () => {
    const events: AsciinemaCastEvent[] = [
      [0, 'o', 'hello'],
      [1.5, 'o', ' world\r\n'],
      [2, 'i', 'ls\r'],
    ];
    const cast = serializeAsciinemaCast(header, events);
    const lines = cast.trimEnd().split('\n');
    expect(lines).toHaveLength(1 + events.length);
    expect(JSON.parse(lines[1]!)).toEqual([0, 'o', 'hello']);
    expect(JSON.parse(lines[2]!)).toEqual([1.5, 'o', ' world\r\n']);
    expect(JSON.parse(lines[3]!)).toEqual([2, 'i', 'ls\r']);
  });

  it('rejects bad version/size/events', () => {
    expect(() =>
      serializeAsciinemaCast({ version: 1 as 2, width: 80, height: 24 }),
    ).toThrow(/version/);
    expect(() => serializeAsciinemaCast({ version: 2, width: 0, height: 24 })).toThrow(/width/);
    expect(() => serializeAsciinemaCast({ version: 2, width: 80, height: -1 })).toThrow(/height/);
    expect(() =>
      serializeAsciinemaCast(header, [[-1, 'o', 'x']] as AsciinemaCastEvent[]),
    ).toThrow(/time/);
    expect(() =>
      serializeAsciinemaCast(header, [[0, 'x' as 'o', 'x']] as AsciinemaCastEvent[]),
    ).toThrow(/type/);
  });
});

describe('joinBufferLines', () => {
  it('joins lines with newline and trims trailing blanks', () => {
    expect(joinBufferLines(['a', 'b  ', '', ''])).toBe('a\nb');
  });

  it('preserves interior blank lines', () => {
    expect(joinBufferLines(['a', '', 'b'])).toBe('a\n\nb');
  });

  it('returns empty string for empty/all-blank input', () => {
    expect(joinBufferLines([])).toBe('');
    expect(joinBufferLines(['', '  '])).toBe('');
  });
});
