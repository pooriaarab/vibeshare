# vibeshare

Share your live agent coding session by URL — traces.com-style, open source, CLI-first. Spectators watch read-only; invite links let viewers request to join as collaborators (host approves, live).

Part of the **Vibe Suite** — companion tools for agentic coding CLIs (Claude Code, Codex, Gemini, Grok/pi, Kimi). Ships as **CLI + npm package + MCP server**, built on [`@pooriaarab/vibe-core`](https://www.npmjs.com/package/@pooriaarab/vibe-core) (consent ledger, hooks bus, badges).

**Local-first: the share runs on your machine.** The consent ledger gates every share (`share:session` scope), the stream is served straight from your host, and nothing is stored on a server.

## Install & build

```sh
npm install
npm run build      # tsup → dist/ (cli.js, index.js, mcp.js + types)
npm run typecheck  # tsc --noEmit
npm test           # vitest
```

## CLI

```sh
vibeshare                        # share your shell, spectate read-only
vibeshare --invite --expire 1h   # viewers may request to join; auto-expires
vibeshare --pass hunter2         # passphrase second factor
vibeshare -- npm test            # share a specific command
vibeshare --host 0.0.0.0         # share on your LAN (default: loopback only)

vibeshare viewers                # who's watching, pending join requests
vibeshare viewers --approve <id> # promote a viewer to collaborator
vibeshare viewers --kick <id>    # remove a viewer, live
vibeshare stop                   # end the share (works from another terminal)
```

Running `vibeshare` prints the link:

```
● local · no data out
  sharing:  npm test
  url:      http://127.0.0.1:50613/s/KKxzdjLpr_km
  access:   spectate (read-only)
  expires:  until you stop
  manage:   vibeshare viewers · vibeshare stop
```

Opening the URL shows a self-contained spectator page (no install for viewers) streaming the session live over SSE, with a "Request to join" button on invite links. First run asks for consent (`--yes` to skip); the grant is recorded locally in `~/.vibeshare/consent.json` and can be revoked any time.

Read-only is real: there is no route that lets a viewer write — the host is the server of record, and promotion to collaborator goes only through a host-approved request (`ViewerRegistry.canWrite()` is the single gate).

## npm library

```ts
import { createShare, grantConsent } from 'vibeshare';

grantConsent('share from my tool');              // once; local ledger
const { url, feed, viewers, revoke } = await createShare({
  session: 'npm test',
  access: 'spectate',                            // or 'invite'
  expiry: '1h',                                  // or 'stop'
});

feed.publish('tests starting…');
viewers.on('request', (v) => viewers.approve(v.id));
await revoke();
```

`createShare` throws `ConsentRequiredError` without a `share:session` grant. Bring your own plumbing with `ShareManager`, `LocalHttpTransport`, and `FileConsentStore`.

## MCP server

```json
{
  "mcpServers": {
    "vibeshare": { "command": "vibeshare-mcp" }
  }
}
```

Tools: `vibeshare_create`, `vibeshare_viewers`, `vibeshare_stop` — so an agent can offer "share this session?". Your MCP client's tool-approval prompt is the consent act (recorded with that note). Approving *join requests* stays human-only, via the CLI.

## Architecture & the vibelive seam

vibeshare owns the **link + gate**; session content is an ordered feed served to spectators. The one deliberate seam is transport (`src/transport.ts`):

- **`LocalHttpTransport`** (implemented, default): spectator page + SSE stream + loopback host-control API, served from your machine. Nothing stored on a server.
- **`RelayTransport`** (lands with vibelive): a dumb e2e relay / p2p mesh handing out public `vibeshare.io` URLs — same `ShareTransport` interface, swap-in only. Collaborator input routing is part of that seam and must pass `ViewerRegistry.canWrite()`.

Everything else — consent, access policy, passphrase gate, expiry teardown, viewer registry, revocation — is fully implemented and tested.

## Prototype

The original UX prototype (no build, no network): open [`docs/prototype.html`](docs/prototype.html). Spec: [`docs/spec.md`](docs/spec.md).
