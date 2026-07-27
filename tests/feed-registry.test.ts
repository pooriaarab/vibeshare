import { describe, expect, it, vi } from 'vitest';
import { makeEvent } from '@pooriaarab/vibe-core';
import { SessionFeed } from '../src/feed.js';
import { ViewerRegistry } from '../src/registry.js';
import { ShareError, type ShareAccess } from '../src/types.js';

describe('SessionFeed', () => {
  it('publishes entries with monotonic seq numbers', () => {
    const feed = new SessionFeed();
    const a = feed.publish('one');
    const b = feed.publish('two', { stream: 'stderr' });
    expect(a.seq).toBe(1);
    expect(b.seq).toBe(2);
    expect(b.stream).toBe('stderr');
    expect(feed.backlog().map((e) => e.text)).toEqual(['one', 'two']);
  });

  it('fans out to subscribers and stops after unsubscribe', () => {
    const feed = new SessionFeed();
    const seen: string[] = [];
    const unsub = feed.subscribe((e) => seen.push(e.text));
    feed.publish('a');
    unsub();
    feed.publish('b');
    expect(seen).toEqual(['a']);
    expect(feed.backlog()).toHaveLength(2);
  });

  it('caps the replay log (ring buffer)', () => {
    const feed = new SessionFeed(3);
    for (let i = 1; i <= 5; i++) feed.publish(`line ${i}`);
    expect(feed.backlog().map((e) => e.text)).toEqual(['line 3', 'line 4', 'line 5']);
    expect(feed.backlog()[0]!.seq).toBe(3);
  });

  it('formats vibe-core milestone events', () => {
    const feed = new SessionFeed();
    const entry = feed.publishEvent(makeEvent('task-done', 'kimi', '/tmp', { detail: 'commit abc' }));
    expect(entry.type).toBe('milestone');
    expect(entry.text).toBe('◆ task-done · kimi — commit abc');
  });

  it('system lines are typed', () => {
    const feed = new SessionFeed();
    expect(feed.system('hello').type).toBe('system');
  });

  it('close notifies subscribers and refuses further publishes', () => {
    const feed = new SessionFeed();
    const onClose = vi.fn();
    feed.once('close', onClose);
    feed.close();
    expect(onClose).toHaveBeenCalledOnce();
    expect(feed.closed).toBe(true);
    expect(() => feed.publish('nope')).toThrow(/closed/);
    feed.close(); // idempotent
    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe('ViewerRegistry', () => {
  const registryOf = (access: ShareAccess) => new ViewerRegistry(() => access);

  it('everyone enters as a read-only spectator', () => {
    const reg = registryOf('invite');
    const v = reg.add('Maya');
    expect(v.role).toBe('spectator');
    expect(v.name).toBe('Maya');
    expect(v.token).toMatch(/^[0-9a-f]{32}$/);
    expect(reg.canWrite(v.id)).toBe(false);
    expect(reg.getByToken(v.token)?.id).toBe(v.id);
  });

  it('sanitizes names and falls back to anon', () => {
    const reg = registryOf('spectate');
    expect(reg.add('   ').name).toMatch(/^anon-[0-9a-f]{4}$/);
    expect(reg.add('x'.repeat(100)).name).toHaveLength(32);
  });

  it('request-to-join requires an invite share', () => {
    const reg = registryOf('spectate');
    const v = reg.add();
    expect(() => reg.requestJoin(v.id)).toThrowError(
      expect.objectContaining({ code: 'invite-disabled' }) as ShareError,
    );
  });

  it('request → approve promotes to collaborator who can write', () => {
    const reg = registryOf('invite');
    const events: string[] = [];
    reg.on('request', () => events.push('request'));
    reg.on('approve', () => events.push('approve'));
    const v = reg.add();
    reg.requestJoin(v.id);
    expect(v.joinRequest).toBe('pending');
    expect(reg.canWrite(v.id)).toBe(false); // pending ≠ write
    reg.approve(v.id);
    expect(v.role).toBe('collaborator');
    expect(reg.canWrite(v.id)).toBe(true);
    expect(events).toEqual(['request', 'approve']);
  });

  it('deny keeps the viewer a spectator', () => {
    const reg = registryOf('invite');
    const v = reg.add();
    reg.requestJoin(v.id);
    reg.deny(v.id);
    expect(v.joinRequest).toBe('denied');
    expect(v.role).toBe('spectator');
    expect(reg.canWrite(v.id)).toBe(false);
  });

  it('approve/deny require a pending request', () => {
    const reg = registryOf('invite');
    const v = reg.add();
    expect(() => reg.approve(v.id)).toThrowError(expect.objectContaining({ code: 'not-pending' }) as ShareError);
    expect(() => reg.deny(v.id)).toThrowError(expect.objectContaining({ code: 'not-pending' }) as ShareError);
  });

  it('double request is a conflict', () => {
    const reg = registryOf('invite');
    const v = reg.add();
    reg.requestJoin(v.id);
    expect(() => reg.requestJoin(v.id)).toThrowError(
      expect.objectContaining({ code: 'already-pending' }) as ShareError,
    );
  });

  it('kick removes the viewer entirely', () => {
    const reg = registryOf('invite');
    const kicked: string[] = [];
    reg.on('kick', (v) => kicked.push(v.id));
    const v = reg.add();
    reg.kick(v.id);
    expect(reg.get(v.id)).toBeUndefined();
    expect(reg.canWrite(v.id)).toBe(false);
    expect(kicked).toEqual([v.id]);
    expect(() => reg.kick(v.id)).toThrowError(expect.objectContaining({ code: 'not-found' }) as ShareError);
  });

  it('leave is a quiet no-op for unknown viewers', () => {
    const reg = registryOf('spectate');
    const v = reg.add();
    reg.leave(v.id);
    expect(reg.count()).toBe(0);
    reg.leave('nobody'); // must not throw
  });
});
