import { describe, expect, it } from 'vitest';
import { redact } from '../src/transcript/redact.js';

describe('redact', () => {
  it.each([
    // Fixtures are split with `+` so no complete token literal sits in the
    // source (GitHub push-protection scans literals); the concatenated runtime
    // value still exercises the redaction regexes.
    ['OpenAI key', 'sk-proj-' + '1234567890abcdef1234567890'],
    ['Anthropic key', 'sk-ant-' + 'api03-1234567890abcdef1234567890'],
    ['Slack token', 'xoxb' + '-1234567890-1234567890-abcdefghijklmnop'],
    ['GitHub classic token', 'ghp_' + '1234567890abcdefghijklmnopqrstuvwxyz'],
    ['GitHub fine-grained token', 'github_pat_' + '11AA22BB33CC44DD55EE66FF_abcdefghijklmnopqrstuvwxyz'],
    ['AWS access key', 'AKIA' + 'IOSFODNN7EXAMPLE'],
    ['Google API key', 'AIza' + 'SyD-1234567890abcdefghijklmnopq'],
  ])('masks %s', (_label, secret) => {
    const output = redact(`before ${secret} after`);
    expect(output).not.toContain(secret);
    expect(output).toContain('«redacted:');
  });

  it.each([
    ['bearer token', 'Authorization: Bearer ' + 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.signature'],
    ['secret assignment', 'CLIENT_SECRET=super-secret-value'],
    ['token assignment', 'access_token="super-secret-value"'],
    ['password assignment', 'DB_PASSWORD: hunter2'],
  ])('masks %s', (_label, secret) => {
    const output = redact(`before ${secret} after`);
    expect(output).not.toContain(secret.split(/[:=]/).pop()!.replaceAll('"', '').trim());
    expect(output).toContain('«redacted:');
  });

  it('masks PEM blocks', () => {
    const pem = [
      '-----BEGIN PRIVATE KEY-----',
      'MIIEvQIB' + 'ADANBgkqhkiG9w0BAQEFAASC',
      '-----END PRIVATE KEY-----',
    ].join('\n');
    const output = redact(`key:\n${pem}`);
    expect(output).not.toContain('BEGIN PRIVATE KEY');
    expect(output).not.toContain('MIIEvQIB');
    expect(output).toContain('«redacted:');
  });

  it('masks long high-entropy blobs but leaves normal prose and code alone', () => {
    const hex = '0123456789abcdef'.repeat(4);
    const base64 = 'QWxhZGRpbjpvcGVuIHNlc2FtZQ'.repeat(2);
    expect(redact(`hash=${hex}`)).not.toContain(hex);
    expect(redact(`blob=${base64}`)).not.toContain(base64);
    expect(redact('The quick brown fox jumps over the lazy dog.')).toBe(
      'The quick brown fox jumps over the lazy dog.',
    );
    expect(redact('const greeting = "hello world";')).toBe('const greeting = "hello world";');
  });

  it('only treats assignment values as secrets when the key name is sensitive', () => {
    expect(redact('PORT=3000 FOO=ordinary-value')).toBe('PORT=3000 FOO=ordinary-value');
    expect(redact('API_KEY=ordinary-value')).not.toContain('ordinary-value');
  });

  it('caps output and marks truncation', () => {
    const output = redact('a'.repeat(5000));
    expect(output.length).toBeLessThanOrEqual(4000);
    expect(output).toContain('[truncated]');
  });
});
