# vibeshare

Share your live agent coding session by URL — traces.com-style, open source, CLI-first. Spectators watch read-only; invite links let viewers request to join as collaborators (host approves, live).

Part of the **Vibe Suite** — companion tools for agentic coding CLIs (Claude Code, Codex, Gemini, Grok/pi, Kimi). Ships as **CLI + npm package + MCP server**, built on [`@pooriaarab/vibe-core`](https://www.npmjs.com/package/@pooriaarab/vibe-core) (consent ledger, hooks bus, badges).

**Local-first: the share runs on your machine.** The consent ledger gates every share (`share:session` scope), the stream is served straight from your host, and nothing is stored on a server.

## Works with any harness

vibeshare shares a LIVE TERMINAL SESSION. It wraps a PTY, so the program inside is irrelevant — any agent CLI, shell, or TUI renders faithfully (colors, cursor, full-screen) via xterm.js in the browser.

**Two ways to share a session:**
- **Wrap at launch (no tmux):** `vibeshare --public -- <harness>` — vibeshare is the parent, PTY-captures. Examples: `vibeshare --public -- claude`, `-- codex`, `-- gemini`, `-- aider`, `-- opencode`, `-- kimi`, `-- amp`, or any shell/command.
- **Attach to an already-running session (needs tmux):** run the harness inside tmux, then `vibeshare attach <pane>` taps it live. Harness-agnostic — it captures the terminal, not the app.

**Verified harnesses** (all render the real TUI live): Claude Code (`claude`), OpenAI Codex (`codex`), Gemini CLI (`gemini`), aider (requires `pip install aider-chat`), opencode, Moonshot Kimi (`kimi`), pi (grok/glm), Sourcegraph amp (requires its own PATH setup). Others (Continue, Goose, Crush, Qwen, Cursor Agent, Warp, Zed, …) wrap identically — they're just terminal programs.

| Need | Command |
| :--- | :--- |
| Share a new claude session | `vibeshare --public -- claude` |
| Share a running session | Run it in tmux + `vibeshare attach <pane>` |
| Local-only sharing | `vibeshare -- <cmd>` |

*Modes:* `--public` (WebRTC P2P + e2e via getvibe.dev), `--tunnel <provider>` (12 providers, e2e), or local loopback/LAN. Presence + attributed chat included.

## Demo

[▶ Watch the launch video](branding/launch-video.mp4) — claude is multiplayer now.

https://github.com/pooriaarab/vibeshare/raw/main/branding/launch-video.mp4

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

## Reliable connectivity (TURN)

`--public` shares are peer-to-peer with **STUN only** by default (free, no infra) — that works across most NATs. If viewers sit behind symmetric NATs or isolated networks and get stuck on "waiting for host", add a **TURN relay**: ICE config is set on the host and automatically propagated to viewers over signaling, so both ends use it.

Precedence, highest first:

1. `--ice-servers '<json>'` CLI flag — a JSON array of RTCIceServer objects
2. `VIBESHARE_ICE_SERVERS` env var (same JSON)
3. `~/.vibeshare/config.json` → `"iceServers"` key
4. default: `[{ "urls": "stun:stun.l.google.com:19302" }]` (STUN only)

```jsonc
// ~/.vibeshare/config.json — self-hosted coturn, or a provider
// (metered.ca, Twilio, Cloudflare Calls TURN, …)
{
  "iceServers": [
    { "urls": "stun:stun.l.google.com:19302" },
    {
      "urls": "turn:turn.example.com:3478",
      "username": "vibeshare",
      "credential": "long-lived-or-temporary-secret"
    }
  ]
}
```

The credentials are the host's own (short-lived tokens by convention); they travel over the signaling channel to viewers so the browser can reach the relay. Malformed flag/env JSON is reported and skipped — resolution falls through to the next source, never breaking the share.

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
