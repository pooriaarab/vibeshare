/**
 * vibeshare MCP server (stdio). Exposes two tools an agent can call:
 *
 *   - create_share  — host a vibelive session wrapping a command, mint a share URL
 *                     with an access policy (+ optional expiry/passphrase), and
 *                     return the capability URL + relay URL. Lives for the MCP
 *                     process lifetime (or until the wrapped agent exits).
 *   - viewers       — list active shares and their viewer rosters (connected
 *                     spectators/participants + pending join requests).
 *
 * Uses the high-level `McpServer` API from `@modelcontextprotocol/sdk`. Input
 * schemas are Zod raw shapes (the SDK's expected form); zod is a transitive
 * dependency of the SDK and gets bundled into dist/mcp.js by tsup.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { createHost, createRelay, SHARE_SESSION_SCOPE } from 'vibelive-cli';
import type { RelayHandle } from 'vibelive-cli';
import { createShare } from './share.js';
import type { ShareHandle } from './share.js';
import { VERSION } from './version.js';

interface ActiveShare {
  readonly id: string;
  readonly url: string;
  readonly relayUrl: string;
  readonly access: string;
  readonly command: readonly string[];
  readonly share: ShareHandle;
  readonly relay: RelayHandle;
}

/**
 * Build the vibeshare MCP server (tools registered, not yet connected).
 *
 * `sessions` defaults to a fresh module-level map so independent `createMcpServer`
 * calls don't share state, but a single stdio process keeps one map for its
 * lifetime (so `viewers` sees shares started via `create_share`).
 */
export function createMcpServer(sessions: Map<string, ActiveShare> = new Map()): McpServer {
  const server = new McpServer(
    { name: 'vibeshare', version: VERSION },
    {
      capabilities: { tools: {} },
      instructions:
        'vibeshare lets an agent share a live coding session by URL. Use create_share to host a ' +
        'wrapped agent command and get a shareable capability URL (spectate read-only or invite to ' +
        'collaborate); use viewers to list active shares and their audiences.',
    },
  );

  server.registerTool(
    'create_share',
    {
      title: 'Create a vibeshare URL',
      description:
        'Host a vibelive session wrapping an agent command (e.g. ["claude"]) and mint a vibeshare ' +
        'capability URL for it. Returns the share URL (vibeshare.stream/s/<id>), the local relay URL ' +
        'viewers connect over, the access mode, and the share id. Spectators are read-only; "invite" ' +
        'lets link holders request to join (host approves to let them drive).',
      inputSchema: {
        command: z
          .array(z.string())
          .min(1)
          .describe('The agent command to wrap, argv-style, e.g. ["claude"] or ["python","-i"].'),
        access: z
          .enum(['spectate', 'invite'])
          .optional()
          .describe('Access policy for link holders. Default: spectate (read-only).'),
        expire: z
          .enum(['1h', '24h'])
          .optional()
          .describe('Auto-revoke the share after this duration.'),
        pass: z
          .string()
          .optional()
          .describe('Optional passphrase — a second factor on top of the share URL.'),
        name: z
          .string()
          .optional()
          .describe('Optional display name for the host participant.'),
      },
    },
    async ({ command, access, expire, pass, name }) => {
      const host = createHost({ command });
      const relay = await createRelay({
        port: 0,
        hostHandle: host,
        initialDriver: 'host',
        hostParticipantName: name ?? 'host',
      });
      relay.consent.grant(SHARE_SESSION_SCOPE);

      const share = createShare({
        session: relay,
        access: access ?? 'spectate',
        expiry: expire,
        passphrase: pass,
      });
      const rec: ActiveShare = {
        id: share.id,
        url: share.url,
        relayUrl: relay.url,
        access: share.access,
        command,
        share,
        relay,
      };
      sessions.set(share.id, rec);
      void host.exited.then(async () => {
        sessions.delete(share.id);
        await share.revoke();
      });

      const lines = [
        'vibeshare session ready.',
        `id: ${share.id}`,
        `url: ${share.url}`,
        `relay: ${relay.url}`,
        `access: ${share.access}${pass ? ' \u00B7 passphrase' : ''}${expire ? ` \u00B7 expires ${expire}` : ''}`,
      ];
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
  );

  server.registerTool(
    'viewers',
    {
      title: 'List vibeshare sessions + viewers',
      description:
        'List active vibeshare shares started via create_share. Each entry includes the share id, ' +
        'share URL, access mode, and the current viewer roster (connected viewers by role, plus ' +
        'pending join requests under invite access).',
      inputSchema: {
        id: z
          .string()
          .optional()
          .describe('Optional: return only the share whose id (or URL) matches.'),
      },
    },
    async ({ id }) => {
      const wantId = id ? parseShareIdLoose(id) : undefined;
      const rows: unknown[] = [];
      for (const s of sessions.values()) {
        if (wantId !== undefined && s.id !== wantId && s.url !== id) continue;
        const roster = s.share.viewers();
        rows.push({
          id: s.id,
          url: s.url,
          relay: s.relayUrl,
          access: s.access,
          command: s.command,
          viewers: roster.viewers.map((v) => ({ id: v.id, name: v.name, role: v.role })),
          pending: roster.pending.map((v) => ({ id: v.id, name: v.name })),
          revoked: s.share.revoked,
        });
      }
      const text =
        rows.length === 0 ? 'no active vibeshare shares' : JSON.stringify(rows, null, 2);
      return { content: [{ type: 'text', text }] };
    },
  );

  return server;
}

/** Extract a share id from a bare id or a full share URL (best-effort). */
function parseShareIdLoose(input: string): string {
  const slash = input.lastIndexOf('/s/');
  return slash >= 0 ? input.slice(slash + 3) : input;
}

/** Create the server, wire it to stdio, and run until the client disconnects. */
export async function runMcpStdio(): Promise<void> {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  await new Promise((resolve) => {
    process.stdin.once('end', resolve);
    process.stdin.once('close', resolve);
  });
}
