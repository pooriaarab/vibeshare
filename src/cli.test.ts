import { describe, expect, it } from 'vitest';
import { parseArgs } from './cli.js';

describe('parseArgs — meta commands', () => {
  it('defaults to help on no args', () => {
    expect(parseArgs([])).toEqual({ cmd: 'help' });
  });
  it('honours --help / -h', () => {
    expect(parseArgs(['--help'])).toEqual({ cmd: 'help' });
    expect(parseArgs(['-h'])).toEqual({ cmd: 'help' });
  });
  it('honours --version / -v', () => {
    expect(parseArgs(['--version'])).toEqual({ cmd: 'version' });
    expect(parseArgs(['-v'])).toEqual({ cmd: 'version' });
  });
  it('recognizes the standalone subcommands', () => {
    expect(parseArgs(['mcp'])).toEqual({ cmd: 'mcp' });
    expect(parseArgs(['stop'])).toEqual({ cmd: 'stop' });
    expect(parseArgs(['viewers'])).toEqual({ cmd: 'viewers' });
  });
});

describe('parseArgs — host (the implicit `vibeshare -- <cmd>` form)', () => {
  it('hosts with default spectate access', () => {
    expect(parseArgs(['--', 'claude'])).toEqual({
      cmd: 'host',
      command: ['claude'],
      access: 'spectate',
    });
  });

  it('honours --spectate / --invite', () => {
    expect(parseArgs(['--spectate', '--', 'claude'])).toMatchObject({
      cmd: 'host',
      access: 'spectate',
      command: ['claude'],
    });
    expect(parseArgs(['--invite', '--', 'claude'])).toMatchObject({
      cmd: 'host',
      access: 'invite',
      command: ['claude'],
    });
  });

  it('passes everything after `--` through verbatim (incl. the wrapped command own flags)', () => {
    // `vibeshare -- claude --version` wraps `claude --version`, NOT our version.
    expect(parseArgs(['--', 'claude', '--version'])).toEqual({
      cmd: 'host',
      command: ['claude', '--version'],
      access: 'spectate',
    });
    expect(parseArgs(['--', 'claude', '--help'])).toMatchObject({ cmd: 'host' });
    expect(parseArgs(['--', 'python', '-i', '-u'])).toMatchObject({
      command: ['python', '-i', '-u'],
    });
  });
});

describe('parseArgs — explicit `host` subcommand', () => {
  it('accepts `vibeshare host -- <cmd>` with the same flags', () => {
    expect(parseArgs(['host', '--', 'claude'])).toEqual({
      cmd: 'host',
      command: ['claude'],
      access: 'spectate',
    });
  });

  it('parses every host flag together', () => {
    expect(
      parseArgs([
        'host',
        '--invite',
        '--expire',
        '24h',
        '--pass',
        'hunter2',
        '--name',
        'me',
        '--',
        'python',
        '-i',
      ]),
    ).toEqual({
      cmd: 'host',
      command: ['python', '-i'],
      access: 'invite',
      expire: '24h',
      pass: 'hunter2',
      name: 'me',
    });
  });

  it('accepts --expire 1h', () => {
    expect(parseArgs(['--expire', '1h', '--', 'claude'])).toMatchObject({ expire: '1h' });
  });
});

describe('parseArgs — errors', () => {
  it('rejects unknown commands', () => {
    expect(parseArgs(['bogus'])).toMatchObject({ cmd: 'error', message: /unknown command: bogus/ });
  });

  it('rejects unknown flags', () => {
    expect(parseArgs(['--nope', '--', 'claude'])).toMatchObject({ cmd: 'error', message: /unknown flag/ });
  });

  it('requires a command after `--`', () => {
    expect(parseArgs(['--invite'])).toMatchObject({ cmd: 'error', message: /needs a command/ });
    expect(parseArgs(['host'])).toMatchObject({ cmd: 'error', message: /needs a command/ });
  });

  it('validates --expire values', () => {
    expect(parseArgs(['--expire', '2h', '--', 'claude'])).toMatchObject({
      cmd: 'error',
      message: /must be "1h" or "24h"/,
    });
    expect(parseArgs(['--expire', '--', 'claude'])).toMatchObject({
      cmd: 'error',
      message: /requires a value/,
    });
  });

  it('validates --pass / --name require a value', () => {
    expect(parseArgs(['--pass', '--', 'claude'])).toMatchObject({ cmd: 'error', message: /--pass/ });
    expect(parseArgs(['--name', '--', 'claude'])).toMatchObject({ cmd: 'error', message: /--name/ });
  });
});
