# vibeshare

Share your live agent coding session by URL — traces.com-style, open source, CLI-first. Spectate read-only or invite into the vibelive multiplayer engine.

Part of the **Vibe Suite** — companion tools for agentic coding CLIs (Claude Code, Codex, Gemini, Grok/pi, Kimi). Ships as **CLI + npm package + MCP server**.

**Local-first: runs on your own machine, no data out** (consent model in `@pooriaarab/vibe-core`).

> Status: **v0** — the share/access layer over [`@pooriaarab/vibelive`](https://www.npmjs.com/package/@pooriaarab/vibelive) is implemented (CLI, library, MCP). Local/LAN, host-authoritative. E2e relay fan-out to ~1000 spectators is on the vibelive roadmap.

## Install

```bash
npm install -g vibeshare-live
# or use it inline:
npx vibeshare-live -- claude
```

It pulls in `@pooriaarab/vibelive` (the multiplayer engine) and `@pooriaarab/vibe-core` (the consent ledger).

## Quick start

Host your agent and hand someone a link:

```bash
vibeshare --invite -- claude
```

You'll get back something like:

```
vibeshare — sharing claude
  share:  https://vibeshare.stream/s/a5e3a635-0bb7-4689-973c-5fe2d7de6207
  access: invite · no expiry
  relay:  ws://localhost:55410
  ● p2p · e2e · nothing stored on a server
```

Send them the `share` URL. They spectate read-only; with `--invite` they can request to join and you `/approve <id>` to let them drive. Slash commands inside the host session: `/drive` `/release` `/viewers` `/approve <id>` `/stop`.

| Flag | Meaning |
| --- | --- |
| `--spectate` | link holders get read-only access (default) |
| `--invite` | link holders may request to join; you approve to let them drive |
| `--expire 1h\|24h` | auto-revoke the share after this duration |
| `--pass <p>` | require a passphrase on top of the share URL |

`vibeshare --version` · `vibeshare --help` · `vibeshare mcp`

## Your own domain, not vibe.live

The share URL reads `vibeshare.stream/s/<id>` — **vibeshare's own domain** (available $4/yr), not `vibe.live`. The link is a capability URL: the id is the only thing that grants access (122 bits of entropy), so it's unguessable. Optional `--pass` adds a second factor.

The actual live stream runs over the local/LAN WebSocket relay that vibelive starts on your machine. The `vibeshare.stream` URL is the identity layer; the bytes flow over a self-hostable relay.

## Peer-to-peer, end-to-end encrypted, nothing stored on a server

The session stream runs **peer-to-peer / via a dumb e2e-encrypted relay** that forwards opaque blobs. The relay cannot decrypt anything — nothing readable is ever stored on a server, and the relay is self-hostable. This is vibelive's transport (§1–2 of its tech spec); vibeshare is the URL/access layer on top. Fanning session output off your machine is gated behind the `share:session` consent scope.

## As a library

```ts
import { createHost, createRelay } from '@pooriaarab/vibelive';
import { createShare } from 'vibeshare-live';

const host = createHost({ command: ['claude'] });
const relay = await createRelay({ port: 0, hostHandle: host, initialDriver: 'host' });

const share = createShare({
  session: relay,
  access: 'spectate',      // 'spectate' (read-only) | 'invite' (can join to drive)
  expiry: '1h',            // optional: '1h' | '24h' | number(ms)
  passphrase: 'sekret',    // optional second factor
});

console.log(share.url);    // https://vibeshare.stream/s/<id>
const { viewers, pending } = share.viewers();
await share.revoke();      // tear down (also fires on expiry)
```

Spectators are enforced read-only at the access gate: a spectator's control request never reaches vibelive's `WriteArbiter`, so they can never obtain the write token — the same "never two concurrent writers" invariant vibelive holds, extended to the share.

## As an MCP server

Wire it into an agent that speaks MCP and it can offer "share this session?":

```jsonc
// .mcp.json or your client's MCP config
{
  "mcpServers": {
    "vibeshare": { "command": "vibeshare", "args": ["mcp"] }
  }
}
```

Tools: `create_share` (host a command, mint a share URL) and `viewers` (list active shares + their audiences).

## Prototype

Interactive, self-contained UX prototype (no build, no network): open [`docs/prototype.html`](docs/prototype.html) in a browser.

## License

MIT.
