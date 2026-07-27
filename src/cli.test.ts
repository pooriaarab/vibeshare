import { describe, expect, it } from 'vitest';
import { parseArgv } from './cli.js';

describe('parseArgv — meta commands', () => {
  it('defaults to help on no args', () => {
    expect(parseArgv([])).toEqual({ cmd: 'help' });
  });
  it('honours --help / -h', () => {
    expect(parseArgv(['--help'])).toEqual({ cmd: 'help' });
    expect(parseArgv(['-h'])).toEqual({ cmd: 'help' });
  });
  it('honours --version / -v', () => {
    expect(parseArgv(['--version'])).toEqual({ cmd: 'version' });
    expect(parseArgv(['-v'])).toEqual({ cmd: 'version' });
  });
  it('recognizes the standalone subcommands', () => {
    expect(parseArgv(['mcp'])).toEqual({ cmd: 'mcp' });
    expect(parseArgv(['stop'])).toEqual({ cmd: 'stop' });
    expect(parseArgv(['viewers'])).toEqual({ cmd: 'viewers' });
  });
});

describe('parseArgv — host (the implicit `vibeshare -- <cmd>` form)', () => {
  it('hosts with default spectate access', () => {
    expect(parseArgv(['--', 'claude'])).toEqual({
      cmd: 'host',
      command: ['claude'],
      access: 'spectate',
    });
  });

  it('honours --spectate / --invite', () => {
    expect(parseArgv(['--spectate', '--', 'claude'])).toMatchObject({
      cmd: 'host',
      access: 'spectate',
      command: ['claude'],
    });
    expect(parseArgv(['--invite', '--', 'claude'])).toMatchObject({
      cmd: 'host',
      access: 'invite',
      command: ['claude'],
    });
  });

  it('passes everything after `--` through verbatim (incl. the wrapped command own flags)', () => {
    // `vibeshare -- claude --version` wraps `claude --version`, NOT our version.
    expect(parseArgv(['--', 'claude', '--version'])).toEqual({
      cmd: 'host',
      command: ['claude', '--version'],
      access: 'spectate',
    });
    expect(parseArgv(['--', 'claude', '--help'])).toMatchObject({ cmd: 'host' });
    expect(parseArgv(['--', 'python', '-i', '-u'])).toMatchObject({
      command: ['python', '-i', '-u'],
    });
  });
});

describe('parseArgv — explicit `host` subcommand', () => {
  it('accepts `vibeshare host -- <cmd>` with the same flags', () => {
    expect(parseArgv(['host', '--', 'claude'])).toEqual({
      cmd: 'host',
      command: ['claude'],
      access: 'spectate',
    });
  });

  it('parses every host flag together', () => {
    expect(
      parseArgv([
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
    expect(parseArgv(['--expire', '1h', '--', 'claude'])).toMatchObject({ expire: '1h' });
  });
});

describe('parseArgv — errors', () => {
  it('rejects unknown commands', () => {
    expect(parseArgv(['bogus'])).toMatchObject({ cmd: 'error', message: /unknown command: bogus/ });
  });

  it('rejects unknown flags', () => {
    expect(parseArgv(['--nope', '--', 'claude'])).toMatchObject({ cmd: 'error', message: /unknown flag/ });
  });

  it('requires a command after `--`', () => {
    expect(parseArgv(['--invite'])).toMatchObject({ cmd: 'error', message: /needs a command/ });
    expect(parseArgv(['host'])).toMatchObject({ cmd: 'error', message: /needs a command/ });
  });

  it('validates --expire values', () => {
    expect(parseArgv(['--expire', '2h', '--', 'claude'])).toMatchObject({
      cmd: 'error',
      message: /must be "1h" or "24h"/,
    });
    expect(parseArgv(['--expire', '--', 'claude'])).toMatchObject({
      cmd: 'error',
      message: /requires a value/,
    });
  });

  it('validates --pass / --name require a value', () => {
    expect(parseArgv(['--pass', '--', 'claude'])).toMatchObject({ cmd: 'error', message: /--pass/ });
    expect(parseArgv(['--name', '--', 'claude'])).toMatchObject({ cmd: 'error', message: /--name/ });
  });
});
