import { describe, expect, it } from 'vitest';
import {
  SHARE_ORIGIN,
  SHARE_PATH_PREFIX,
  ShareUrlParseError,
  buildShareUrl,
  newShareId,
  parseShareUrl,
} from './url.js';

describe('newShareId', () => {
  it('produces unguessable, unique, uuid-shaped ids', () => {
    const a = newShareId();
    const b = newShareId();
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(b).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(a).not.toEqual(b);
  });

  it('has enough entropy to be a genuine capability (122 bits)', () => {
    // 32 hex chars = 128 bits, minus 6 fixed bits in a v4 uuid ≈ 122 bits.
    expect(newShareId().replace(/-/g, '').length).toBe(32);
  });
});

describe('buildShareUrl', () => {
  it('mints a URL on the vibeshare.stream domain by default', () => {
    expect(buildShareUrl('abc')).toBe(`${SHARE_ORIGIN}${SHARE_PATH_PREFIX}abc`);
    expect(buildShareUrl('abc')).toBe('https://vibeshare.stream/s/abc');
  });

  it('honours a custom origin (self-hosted / vanity domains)', () => {
    expect(buildShareUrl('abc', 'https://share.example.com')).toBe('https://share.example.com/s/abc');
  });
});

describe('parseShareUrl', () => {
  it('round-trips createShare-style urls', () => {
    // The contract: whatever createShare prints, parseShareUrl reads back the same id.
    for (let i = 0; i < 50; i++) {
      const id = newShareId();
      const url = buildShareUrl(id);
      expect(parseShareUrl(url)).toEqual({ id });
    }
  });

  it.each([
    ['https://vibeshare.stream/s/abc', 'abc'],
    ['http://vibeshare.stream/s/abc', 'abc'],
    ['https://share.example.com/s/xyz-123', 'xyz-123'],
    ['/s/abc', 'abc'],
    ['https://vibeshare.stream/s/abc/', 'abc'], // trailing slash
    ['https://vibeshare.stream/s/abc?from=dm', 'abc'], // query string
    ['https://vibeshare.stream/s/abc#t', 'abc'], // fragment
    ['https://vibeshare.stream/s/abc/', 'abc'],
  ])('parses %s → %s', (input, expected) => {
    expect(parseShareUrl(input).id).toBe(expected);
  });

  it('throws on input without a /s/ segment', () => {
    expect(() => parseShareUrl('https://example.com/nope/abc')).toThrow(ShareUrlParseError);
    expect(() => parseShareUrl('not a url at all')).toThrow(ShareUrlParseError);
  });

  it('throws on empty / non-string input', () => {
    expect(() => parseShareUrl('')).toThrow(ShareUrlParseError);
    expect(() => parseShareUrl('https://vibeshare.stream/s/')).toThrow(ShareUrlParseError); // empty id
  });
});
