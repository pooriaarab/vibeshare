/**
 * Host-local persistence: where vibeshare keeps the consent ledger and its
 * record of the currently active share. Everything lives under
 * `~/.vibeshare` (override with `VIBESHARE_HOME`, e.g. in tests) with
 * owner-only permissions — tokens and consent grants never leave the machine.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createConsentLedger, type ConsentGrant, type ConsentLedger, type ConsentStore } from '@pooriaarab/vibe-core';

export function vibeHome(): string {
  return process.env['VIBESHARE_HOME'] ?? join(homedir(), '.vibeshare');
}

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
}

/** Durable ConsentStore backing the vibe-core consent ledger. */
export class FileConsentStore implements ConsentStore {
  readonly file: string;

  constructor(file = join(vibeHome(), 'consent.json')) {
    this.file = file;
  }

  load(): ConsentGrant[] {
    try {
      if (!existsSync(this.file)) return [];
      const parsed: unknown = JSON.parse(readFileSync(this.file, 'utf8'));
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(
        (g): g is ConsentGrant =>
          typeof g === 'object' && g !== null &&
          typeof (g as ConsentGrant).scope === 'string' &&
          typeof (g as ConsentGrant).grantedAt === 'string',
      );
    } catch {
      return [];
    }
  }

  save(grants: ConsentGrant[]): void {
    ensureDir(join(this.file, '..'));
    writeFileSync(this.file, JSON.stringify(grants, null, 2), { mode: 0o600 });
    try { chmodSync(this.file, 0o600); } catch { /* best effort on odd FS */ }
  }
}

/** A consent ledger backed by the host's `~/.vibeshare/consent.json`. */
export function loadLedger(store?: ConsentStore): ConsentLedger {
  return createConsentLedger(store ?? new FileConsentStore());
}

/** What `vibeshare start` records so `viewers` / `stop` can find it later. */
export interface ActiveShareRecord {
  readonly id: string;
  readonly url: string;
  readonly port: number;
  readonly hostToken: string;
  readonly pid: number;
  readonly startedAt: string;
  /**
   * Which transport serves the share. Absent on records written before
   * `--public` existed — treat as 'local-http'. 'webrtc' shares have no
   * local control server (port 0 / empty token): `stop` signals their pid.
   */
  readonly transport?: 'local-http' | 'webrtc';
}

function sharesDir(): string {
  return join(vibeHome(), 'shares');
}

export function writeActiveShare(rec: ActiveShareRecord): void {
  const dir = sharesDir();
  ensureDir(dir);
  const file = join(dir, `${rec.id}.json`);
  writeFileSync(file, JSON.stringify(rec, null, 2), { mode: 0o600 });
  try { chmodSync(file, 0o600); } catch { /* best effort */ }
}

export function readActiveShare(id: string): ActiveShareRecord | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(sharesDir(), `${id}.json`), 'utf8'));
    return isActiveShareRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** All recorded shares, most recent first. May include stale records. */
export function listActiveShares(): ActiveShareRecord[] {
  try {
    const dir = sharesDir();
    if (!existsSync(dir)) return [];
    const records: ActiveShareRecord[] = [];
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.json')) continue;
      try {
        const parsed: unknown = JSON.parse(readFileSync(join(dir, name), 'utf8'));
        if (isActiveShareRecord(parsed)) records.push(parsed);
      } catch { /* skip unreadable record */ }
    }
    return records.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  } catch {
    return [];
  }
}

export function clearActiveShare(id: string): void {
  try { rmSync(join(sharesDir(), `${id}.json`), { force: true }); } catch { /* gone already */ }
}

function isActiveShareRecord(v: unknown): v is ActiveShareRecord {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r['id'] === 'string' &&
    typeof r['url'] === 'string' &&
    typeof r['port'] === 'number' &&
    typeof r['hostToken'] === 'string' &&
    typeof r['pid'] === 'number' &&
    typeof r['startedAt'] === 'string'
  );
}
