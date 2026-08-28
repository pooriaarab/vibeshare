import { clearActiveShare, listActiveShares, readActiveShare, type ActiveShareRecord } from '../consent.js';
import type { CliCommand } from './parse.js';
import type { IO } from './runtimeTypes.js';

async function controlFetch<T>(
  record: ActiveShareRecord,
  path: string,
  init?: { method?: string; body?: Record<string, unknown> },
): Promise<{ ok: true; data: T } | { ok: false; status: number; message: string }> {
  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${record.port}${path}`, {
      method: init?.method ?? 'GET',
      headers: {
        authorization: `Bearer ${record.hostToken}`,
        ...(init?.body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
  } catch {
    return { ok: false, status: 0, message: 'connection refused' };
  }
  const body: unknown = await res.json().catch(() => ({}));
  if (!res.ok) {
    const rec = body as Record<string, unknown>;
    const errVal = rec['error'];
    const message = typeof errVal === 'string' ? errVal : `HTTP ${res.status}`;
    return { ok: false, status: res.status, message };
  }
  return { ok: true, data: body as T };
}

function resolveRecord(shareId: string | undefined, io: IO): ActiveShareRecord | null {
  if (shareId !== undefined) {
    const rec = readActiveShare(shareId);
    if (rec) return rec;
    io.err(`no recorded share ${shareId}`);
    return null;
  }
  const shares = listActiveShares();
  const latest = shares[0];
  if (!latest) {
    io.err('no active vibeshare share — start one with `vibeshare`');
    return null;
  }
  return latest;
}

interface ViewerInfo {
  id: string;
  name: string;
  role: string;
  joinRequest: string;
  joinedAt: string;
}

async function handleViewerAction(
  record: ActiveShareRecord,
  action: string,
  target: string,
  io: IO,
): Promise<number> {
  const res = await controlFetch<{ viewer: ViewerInfo }>(record, `/control/${action}`, {
    method: 'POST',
    body: { share: record.id, viewer: target },
  });
  if (!res.ok) {
    if (res.status === 0) clearActiveShare(record.id);
    io.err(`vibeshare: could not ${action} ${target}: ${res.message}`);
    return 1;
  }
  const v = res.data.viewer;
  if (action === 'approve') io.out(`✓ approved ${v.name} — now a collaborator`);
  else if (action === 'deny') io.out(`✓ denied ${v.name} — stays a spectator`);
  else io.out(`✓ kicked ${v.name}`);
  return 0;
}

async function handleViewerList(
  record: ActiveShareRecord,
  json: boolean,
  io: IO,
): Promise<number> {
  const res = await controlFetch<{ viewers: ViewerInfo[]; watching: number }>(
    record,
    `/control/viewers?share=${encodeURIComponent(record.id)}`,
  );
  if (!res.ok) {
    if (res.status === 0) {
      clearActiveShare(record.id);
      io.err('vibeshare: the share process is not running (stale record cleaned up)');
    } else {
      io.err(`vibeshare: ${res.message}`);
    }
    return 1;
  }
  if (json) {
    io.out(JSON.stringify(res.data, null, 2));
    return 0;
  }
  io.out(`${record.url}`);
  if (res.data.viewers.length === 0) {
    io.out('  no viewers yet');
    return 0;
  }
  for (const v of res.data.viewers) {
    const pending = v.joinRequest === 'pending' ? `  ⏳ requested to join — vibeshare viewers --approve ${v.id}` : '';
    io.out(`  ${v.id}  ${v.name}  [${v.role}]${pending}`);
  }
  io.out(`  ${res.data.watching} watching now`);
  return 0;
}

function getViewerAction(cmd: Extract<CliCommand, { cmd: 'viewers' }>): { action: string; target: string } | null {
  if (cmd.approve !== undefined) return { action: 'approve', target: cmd.approve };
  if (cmd.deny !== undefined) return { action: 'deny', target: cmd.deny };
  if (cmd.kick !== undefined) return { action: 'kick', target: cmd.kick };
  return null;
}

export async function viewersCommand(
  cmd: Extract<CliCommand, { cmd: 'viewers' }>,
  io: IO,
): Promise<number> {
  const record = resolveRecord(cmd.share, io);
  if (!record) return 1;
  const needsControl = record.transport === 'webrtc' && (!record.port || !record.hostToken);
  if (needsControl) {
    io.err('vibeshare: this public share has no host control endpoint (upgrade the sharing process)');
    return 1;
  }
  const act = getViewerAction(cmd);
  if (act) return handleViewerAction(record, act.action, act.target, io);
  return handleViewerList(record, cmd.json, io);
}

export async function stopCommand(cmd: Extract<CliCommand, { cmd: 'stop' }>, io: IO): Promise<number> {
  const record = resolveRecord(cmd.share, io);
  if (!record) return 1;
  const isLegacyPublic = record.transport === 'webrtc' && (!record.port || !record.hostToken);
  if (isLegacyPublic) {
    try {
      process.kill(record.pid, 'SIGTERM');
      clearActiveShare(record.id);
      io.out(`✓ stopped ${record.url}`);
    } catch {
      clearActiveShare(record.id);
      io.err('vibeshare: the share process was not running (record cleaned up)');
    }
    return 0;
  }
  const res = await controlFetch<{ stopped: string }>(record, '/control/stop', {
    method: 'POST',
    body: { share: record.id },
  });
  clearActiveShare(record.id);
  if (!res.ok) {
    const msg = res.status === 0 ? 'vibeshare: the share process was not running (record cleaned up)' : `vibeshare: ${res.message}`;
    io.err(msg);
    return res.status === 0 ? 0 : 1;
  }
  io.out(`✓ stopped ${record.url}`);
  return 0;
}
