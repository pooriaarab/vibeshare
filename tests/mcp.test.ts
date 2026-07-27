import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createConsentLedger, type ConsentLedger } from '@pooriaarab/vibe-core';
import { LocalHttpTransport } from '../src/localHttp.js';
import { ShareManager, SHARE_SCOPE } from '../src/manager.js';
import { createMcpServer, type McpServer } from '../src/mcp.js';

describe('MCP server (JSON-RPC dispatch)', () => {
  let consent: ConsentLedger;
  let transport: LocalHttpTransport;
  let manager: ShareManager;
  let server: McpServer;

  beforeEach(async () => {
    consent = createConsentLedger();
    transport = new LocalHttpTransport({});
    await transport.listen();
    manager = new ShareManager({ consent, transport });
    server = createMcpServer({ manager, consent });
  });

  afterEach(async () => {
    await manager.stopAll();
    await transport.close();
  });

  const call = (name: string, args: Record<string, unknown> = {}) =>
    server.handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });

  const callResult = async (name: string, args: Record<string, unknown> = {}) => {
    const res = await call(name, args);
    expect(res).not.toBeNull();
    const result = res!.result as { content: Array<{ text: string }>; isError?: boolean };
    return result;
  };

  it('answers initialize with its capabilities', async () => {
    const res = await server.handleMessage({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2024-11-05', clientInfo: { name: 'test' } },
    });
    expect(res).toMatchObject({
      jsonrpc: '2.0', id: 1,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'vibeshare' },
      },
    });
  });

  it('lists the three vibeshare tools', async () => {
    const res = await server.handleMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const tools = (res!.result as { tools: Array<{ name: string }> }).tools;
    expect(tools.map((t) => t.name)).toEqual(['vibeshare_create', 'vibeshare_viewers', 'vibeshare_stop']);
  });

  it('ping pongs, notifications are ignored, unknown methods error', async () => {
    expect(await server.handleMessage({ jsonrpc: '2.0', id: 3, method: 'ping' })).toMatchObject({ result: {} });
    expect(await server.handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull();
    const res = await server.handleMessage({ jsonrpc: '2.0', id: 4, method: 'resources/list' });
    expect(res!.error).toMatchObject({ code: -32601 });
  });

  it('create grants consent (tool approval = consent act) and returns a working URL', async () => {
    expect(consent.allows(SHARE_SCOPE)).toBe(false);
    const result = await callResult('vibeshare_create', { access: 'invite', expiry: '1h', session: 'mcp test' });
    expect(result.isError).toBeUndefined();
    const payload = JSON.parse(result.content[0]!.text) as Record<string, unknown>;
    expect(payload['url']).toMatch(/\/s\/[A-Za-z0-9_-]{12}$/);
    expect(payload['access']).toBe('invite');
    expect(payload['expiresAt']).not.toBeNull();
    expect(consent.allows(SHARE_SCOPE)).toBe(true);
    // The URL really serves the spectator page.
    const page = await fetch(payload['url'] as string);
    expect(page.status).toBe(200);
  });

  it('viewers reports the live share; stop tears it down', async () => {
    await callResult('vibeshare_create', {});
    const viewers = await callResult('vibeshare_viewers');
    const vpayload = JSON.parse(viewers.content[0]!.text) as { share: { state: string }; viewers: unknown[] };
    expect(vpayload.share.state).toBe('live');
    expect(vpayload.viewers).toEqual([]);

    const stopped = await callResult('vibeshare_stop');
    expect(JSON.parse(stopped.content[0]!.text)).toHaveProperty('stopped');

    const after = await callResult('vibeshare_viewers');
    expect(after.isError).toBe(true);
    expect(after.content[0]!.text).toContain('no live shares');
  });

  it('viewers/stop ask for a shareId when several shares are live', async () => {
    await callResult('vibeshare_create', {});
    const second = await callResult('vibeshare_create', {});
    const ambiguous = await callResult('vibeshare_viewers');
    expect(ambiguous.isError).toBe(true);
    expect(ambiguous.content[0]!.text).toContain('multiple live shares');

    const id = (JSON.parse(second.content[0]!.text) as { id: string }).id;
    const targeted = await callResult('vibeshare_stop', { shareId: id });
    expect(targeted.isError).toBeUndefined();
    expect(manager.list()).toHaveLength(1);
  });

  it('unknown tools surface as tool errors, not protocol errors', async () => {
    const res = await call('vibeshare_nope');
    const result = res!.result as { isError?: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('unknown tool');
  });

  it('invalid expiry comes back as a tool error', async () => {
    const result = await callResult('vibeshare_create', { expiry: 'someday' });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('invalid expiry');
  });
});
