#!/usr/bin/env node
/**
 * vibeshare MCP server (stdio transport).
 *
 * Lets an agent offer "share this session?": the MCP client's own tool-approval
 * prompt is the consent UX, so a successful `vibeshare_create` call records the
 * `share:session` grant in the local consent ledger (note: via MCP tool
 * approval). Approval of *join requests* stays with the human via the CLI —
 * the agent can create, list viewers, and stop; it cannot let anyone in.
 *
 * Tools (spec names `vibeshare.create` / `vibeshare.viewers`; MCP tool names
 * allow only [a-zA-Z0-9_-], hence underscores):
 *   vibeshare_create   {session?, access?, expiry?, passphrase?, name?} → {id, url, …}
 *   vibeshare_viewers  {shareId?} → {share, viewers}
 *   vibeshare_stop     {shareId?} → {stopped}
 */
import { createInterface } from 'node:readline';
import { createHookBus, watchCwd, type ConsentLedger, type TriggerKind } from '@pooriaarab/vibe-core';
import { loadLedger } from './consent.js';
import { LocalHttpTransport } from './localHttp.js';
import { ShareManager, SHARE_SCOPE, type CreatedShare } from './manager.js';
import { VERSION } from './version.js';

const PROTOCOL_VERSION = '2024-11-05';

const TOOLS = [
  {
    name: 'vibeshare_create',
    description:
      'Share this live session by URL. Spectators watch read-only; with access="invite" they may request to join (the host approves via the vibeshare CLI). Served from the user\'s machine — nothing is stored on a server.',
    inputSchema: {
      type: 'object',
      properties: {
        session: { type: 'string', description: 'Label for what is being shared (e.g. the agent or task).' },
        access: { type: 'string', enum: ['spectate', 'invite'], description: 'Default spectate (read-only).' },
        expiry: { type: 'string', description: '1h, 24h, 7d, … or "stop" (default).' },
        passphrase: { type: 'string', description: 'Optional passphrase viewers must enter.' },
        name: { type: 'string', description: 'Display name override.' },
      },
    },
  },
  {
    name: 'vibeshare_viewers',
    description: 'List viewers of a live share: who is watching, roles, and pending join requests.',
    inputSchema: {
      type: 'object',
      properties: {
        shareId: { type: 'string', description: 'Share id. Optional when exactly one share is live.' },
      },
    },
  },
  {
    name: 'vibeshare_stop',
    description: 'End a live share: viewers are disconnected and the URL stops working.',
    inputSchema: {
      type: 'object',
      properties: {
        shareId: { type: 'string', description: 'Share id. Optional when exactly one share is live.' },
      },
    },
  },
] as const;

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string };
}

export interface McpServerDeps {
  manager: ShareManager;
  consent: ConsentLedger;
}

export interface McpServer {
  handleMessage(msg: JsonRpcRequest): Promise<JsonRpcResponse | null>;
}

function toolText(value: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

function toolError(message: string): { content: Array<{ type: 'text'; text: string }>; isError: true } {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function resolveShare(manager: ShareManager, shareId: unknown): CreatedShare | string {
  if (typeof shareId === 'string' && shareId.length > 0) {
    const s = manager.get(shareId);
    return s ?? `no live share ${shareId}`;
  }
  const live = manager.list();
  if (live.length === 0) return 'no live shares — call vibeshare_create first';
  if (live.length > 1) {
    return `multiple live shares; pass shareId: ${live.map((s) => s.share.id).join(', ')}`;
  }
  const single = live[0];
  if (single === undefined) return 'no live shares — call vibeshare_create first';
  return single;
}

async function handleCreateTool(
  manager: ShareManager,
  consent: ConsentLedger,
  args: Record<string, unknown>,
): Promise<unknown> {
  // The MCP client's tool-approval prompt is the user's consent act.
  if (!consent.allows(SHARE_SCOPE)) {
    consent.grant(SHARE_SCOPE, 'granted via MCP tool approval');
  }
  const created = await manager.createShare({
    ...(typeof args['session'] === 'string' ? { session: args['session'] } : {}),
    ...(args['access'] === 'invite' || args['access'] === 'spectate' ? { access: args['access'] } : {}),
    ...(typeof args['expiry'] === 'string' ? { expiry: args['expiry'] } : {}),
    ...(typeof args['passphrase'] === 'string' ? { passphrase: args['passphrase'] } : {}),
    ...(typeof args['name'] === 'string' ? { name: args['name'] } : {}),
  });
  created.feed.system('share created by agent via MCP');
  return toolText({
    id: created.share.id,
    url: created.url,
    access: created.share.access,
    expiresAt: created.share.expiresAt,
    note: 'read-only stream served from this machine; manage join requests with `vibeshare viewers`',
  });
}

function handleViewersTool(manager: ShareManager, args: Record<string, unknown>): unknown {
  const share = resolveShare(manager, args['shareId']);
  if (typeof share === 'string') return toolError(share);
  return toolText({
    share: { id: share.share.id, url: share.url, access: share.share.access, state: share.share.state },
    viewers: share.viewers.list().map((v) => ({
      id: v.id, name: v.name, role: v.role, joinRequest: v.joinRequest, joinedAt: v.joinedAt,
    })),
  });
}

async function handleStopTool(manager: ShareManager, args: Record<string, unknown>): Promise<unknown> {
  const share = resolveShare(manager, args['shareId']);
  if (typeof share === 'string') return toolError(share);
  const id = share.share.id;
  await share.revoke();
  return toolText({ stopped: id });
}

type ToolHandler = (args: Record<string, unknown>) => Promise<unknown> | unknown;

function getToolHandlers(manager: ShareManager, consent: ConsentLedger): Record<string, ToolHandler> {
  return {
    vibeshare_create: (args) => handleCreateTool(manager, consent, args),
    vibeshare_viewers: (args) => handleViewersTool(manager, args),
    vibeshare_stop: (args) => handleStopTool(manager, args),
  };
}

async function callTool(
  handlers: Record<string, ToolHandler>,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const fn = Object.hasOwn(handlers, name) ? handlers[name] : undefined;
  if (fn !== undefined) return fn(args);
  return toolError(`unknown tool: ${name}`);
}

function handleInitialize(id: string | number | null, params: Record<string, unknown> | undefined): JsonRpcResponse {
  const requested = params?.['protocolVersion'];
  return {
    jsonrpc: '2.0',
    id,
    result: {
      protocolVersion: typeof requested === 'string' ? requested : PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: 'vibeshare', version: VERSION },
    },
  };
}

async function handleToolsCall(
  id: string | number | null,
  params: Record<string, unknown> | undefined,
  handlers: Record<string, ToolHandler>,
): Promise<JsonRpcResponse> {
  const name = params?.['name'];
  const args = params?.['arguments'];
  if (typeof name !== 'string') {
    return { jsonrpc: '2.0', id, error: { code: -32602, message: 'tools/call needs a tool name' } };
  }
  try {
    const result = await callTool(handlers, name, (typeof args === 'object' && args !== null ? args : {}) as Record<string, unknown>);
    return { jsonrpc: '2.0', id, result };
  } catch (err) {
    return { jsonrpc: '2.0', id, result: toolError(err instanceof Error ? err.message : String(err)) };
  }
}

export function createMcpServer(deps: McpServerDeps): McpServer {
  const { manager, consent } = deps;
  const handlers = getToolHandlers(manager, consent);

  const rpcHandlers: Record<string, (msg: JsonRpcRequest, id: string | number | null) => Promise<JsonRpcResponse | null>> = {
    initialize: async (msg, id) => handleInitialize(id, msg.params),
    ping: async (_msg, id) => ({ jsonrpc: '2.0', id, result: {} }),
    'tools/list': async (_msg, id) => ({ jsonrpc: '2.0', id, result: { tools: TOOLS } }),
    'tools/call': async (msg, id) => handleToolsCall(id, msg.params, handlers),
  };

  return {
    async handleMessage(msg: JsonRpcRequest): Promise<JsonRpcResponse | null> {
      const id = msg.id ?? null;
      const isNotification = msg.id === undefined;
      const method = msg.method ?? '';
      const fn = Object.hasOwn(rpcHandlers, method) ? rpcHandlers[method] : undefined;
      if (fn !== undefined) return fn(msg, id);
      if (isNotification) return null;
      return { jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${String(msg.method)}` } };
    },
  };
}

// ---------------------------------------------------------------- stdio

const HOOK_KINDS: TriggerKind[] = [
  'task-done', 'pr-opened', 'prototype-finished', 'spec-completed',
  'tests-pass', 'tests-fail', 'error', 'session-end', 'manual',
];

export async function startMcp(): Promise<void> {
  const consent = loadLedger();
  const transport = new LocalHttpTransport({});
  await transport.listen();
  const manager = new ShareManager({ consent, transport });
  const server = createMcpServer({ manager, consent });

  // Stream harness-agnostic milestones (commits, sentinel signals) into every
  // live share's feed via the vibe-core hook bus + watcher floor.
  const bus = createHookBus({ onError: (e) => console.error('[vibeshare-mcp] hook error:', e) });
  const watcher = watchCwd(process.cwd(), bus);
  for (const kind of HOOK_KINDS) {
    bus.on(kind, (e) => {
      for (const created of manager.list()) created.feed.publishEvent(e);
    });
  }

  const rl = createInterface({ input: process.stdin });
  // A client closing the pipe (shutdown, crash) must not crash the server.
  process.stdout.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EPIPE') teardown();
    else throw err;
  });
  rl.on('line', (line) => {
    if (line.trim().length === 0) return;
    let msg: JsonRpcRequest;
    try {
      msg = JSON.parse(line) as JsonRpcRequest;
    } catch {
      const res: JsonRpcResponse = { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } };
      process.stdout.write(JSON.stringify(res) + '\n');
      return;
    }
    void server.handleMessage(msg).then((res) => {
      if (res) process.stdout.write(JSON.stringify(res) + '\n');
    });
  });

  const teardown = () => {
    watcher.stop();
    void manager.stopAll().finally(() => process.exit(0));
  };
  process.on('SIGINT', teardown);
  process.on('SIGTERM', teardown);
  // The client closing stdin means the session is over.
  rl.on('close', teardown);

  // Block until teardown calls process.exit. Without this the promise resolves
  // as soon as the listeners are wired, and callers that `process.exit` on the
  // returned code (the `mcp` subcommand via cli.ts run()) would kill the server
  // before it reads a single stdin line.
  await new Promise<void>(() => {});
}
