# vibeshare

<p align="center">Share a live agent coding session by URL, for developers who pair in a browser.</p>

<p align="center">
  <a href="https://www.npmjs.com/package/vibeshare-live"><img src="https://img.shields.io/npm/v/vibeshare-live" alt="npm v0.4.1"/></a>
  <a href="https://github.com/pooriaarab/vibeshare/actions/workflows/oxlint.yml"><img src="https://github.com/pooriaarab/vibeshare/actions/workflows/oxlint.yml/badge.svg" alt="oxlint"/></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="License MIT"/></a>
  <a href="assets/bench.md"><img src="https://img.shields.io/badge/tunnels-12_providers-informational" alt="12 tunnel providers"/></a>
</p>

```text
$ npx vibeshare-live --yes --name demo -- sh -c 'echo hello from vibeshare; sleep 90'
● local · no data out
  sharing:  demo
  url:      http://127.0.0.1:58265/s/TkGE_RWN1kVT
  access:   spectate (read-only)
  expires:  until you stop
  manage:   vibeshare viewers · vibeshare stop
hello from vibeshare
```

<p align="center"><em>A local share printing its spectator URL.</em></p>

## Contents

[Install](#install) · [Quick start](#quick-start) · [Why](#why) · [Share a public session](#share-a-public-session) · [List viewers](#list-viewers) · [Stop the share](#stop-the-share) · [How it works](#how-it-works) · [Configuration](#configuration) · [FAQ](#faq) · [Contributing](#contributing) · [License](#license)

## Install

```bash
npx -y vibeshare-live --version
npx vibeshare-live --yes --name demo -- sh -c 'echo hello from vibeshare; sleep 90'
```

One line to install (npx fetches `vibeshare-live`), one line to run. Node.js 18 or newer. `--yes` writes a `share:session` grant to `~/.vibeshare/consent.json`. A TTY prompt asks the first time if you omit it.

The npm package is `vibeshare-live`. The executable is `vibeshare`. Bins also include `vibeshare-mcp`.

From a clone the package scripts are `build` (tsup to `dist/`), `typecheck`, and `test` (vitest).

## Quick start

```bash
npx vibeshare-live --yes --name demo -- sh -c 'echo hello from vibeshare; sleep 90'
```

```
● local · no data out
  sharing:  demo
  url:      http://127.0.0.1:58265/s/TkGE_RWN1kVT
  access:   spectate (read-only)
  expires:  until you stop
  manage:   vibeshare viewers · vibeshare stop
hello from vibeshare
```

Open the URL on this machine. The spectator page is self-contained. No install for viewers. The default bind is loopback. Use `--host 0.0.0.0` to share on a LAN.

vibeshare wraps a PTY, so the program inside does not matter. Any agent CLI, shell, or TUI renders through xterm.js (colors, cursor, full screen).

Two ways to share:

- Wrap at launch (no tmux): `npx vibeshare-live --yes -- <harness>`
- Attach to a running tmux pane: `npx vibeshare-live attach demo:1.1 --yes`

Verified harnesses: Claude Code (`claude`), OpenAI Codex (`codex`), Gemini CLI (`gemini`), aider, opencode, Moonshot Kimi (`kimi`), pi, Sourcegraph amp. Others (Continue, Goose, Crush, Qwen, Cursor Agent, Warp, Zed) wrap the same way. They are terminal programs.

[Watch the launch video](branding/launch-video.mp4).

## Why

For developers who share a live agent CLI. Today that is traces.com, tmate, or a desktop screen-share. Not for a static log, a gist, or a persistent tmux session on one machine. GNU screen is not supported.

## Share a public session

Viewers off this machine need `--public`. Session frames go over a WebRTC DataChannel. Only the handshake crosses getvibe.dev. The stream is end-to-end encrypted.

```bash
npx vibeshare-live --public --yes --name demo -- sh -c 'echo hello; sleep 25'
```

```
● p2p · nothing stored on a server
  sharing:  demo
  url:      https://getvibe.dev/vibeshare/s/25TbnGWV6LEU#dTl8rp6w10xzDBqwtqO7WJ6lvmlRxwJwUpHPlWdBNtQ
  access:   spectate (read-only)
  expires:  until you stop
  mode:     public · end-to-end encrypted p2p (only the handshake crosses the rendezvous)
  manage:   vibeshare viewers · vibeshare stop
hello
```

`--invite` lets viewers request to join as collaborators. The host approves live. `--expire 1h` (or `24h`, `7d`, `stop`) tears the share down. `--pass` is a passphrase second factor on local and tunnel shares. Public mode does not currently enforce that passphrase.

`--tunnel` (or `--tunnel <provider>`) exposes the local server through one of [12 providers](assets/bench.md). Frames are encrypted before they cross the provider. `--public` and `--tunnel` are mutually exclusive.

## List viewers

```bash
npx vibeshare-live viewers
```

```
http://127.0.0.1:59338/s/nGCH04a5RKOi
  no viewers yet
```

`--approve <id>`, `--deny <id>`, and `--kick <id>` act on a join request or a viewer.

Read-only is real. There is no route that lets a spectator write. Promotion to collaborator goes only through a host-approved request. `ViewerRegistry.canWrite()` is the single gate.

## Stop the share

```bash
npx vibeshare-live stop
```

```
✓ stopped http://127.0.0.1:59338/s/nGCH04a5RKOi
```

Works from another terminal. Pass a share id when more than one share is live.

## How it works

vibeshare owns the link and the gate. It is part of the Vibe Suite. It ships as a CLI, an npm package, and an MCP server. It uses [`@pooriaarab/vibe-core`](https://www.npmjs.com/package/@pooriaarab/vibe-core) for the consent ledger, hooks, and tunnels.

Three transports:

- **Local** (default): spectator page plus SSE, served from this machine. Nothing stored on a server.
- **Public** (`--public`): WebRTC DataChannel. Signaling default `wss://getvibe.dev/vibeshare` (`--signaling`, `VIBESHARE_SIGNALING`, or `~/.vibeshare/config.json`). Point it at your own Worker. See [`worker/`](worker/README.md).
- **Tunnel** (`--tunnel`): local HTTP with an extra encryption layer, then a tunnel provider.

The host is the server of record. Consent scope `share:session` is recorded in `~/.vibeshare/consent.json` and can be revoked.

Attach taps an already-running tmux pane. It needs tmux.

```bash
npx vibeshare-live attach demo:1.1 --yes
```

```
● local · no data out
  sharing:  tmux demo:1.1
  url:      http://127.0.0.1:54669/s/2woHShoc5sPE
  access:   spectate (read-only)
  expires:  until you stop
  manage:   vibeshare viewers · vibeshare stop
  source:   tmux demo:1.1 (attach · read-only)
```

The `trace` subcommand shares a Claude Code or Codex transcript. It is read-only. It redacts likely secrets on a best-effort basis.

The original UX prototype (no build, no network): [`docs/prototype.html`](docs/prototype.html). Draft spec: [`docs/spec.md`](docs/spec.md). Treat the spec as history. Current public links use getvibe.dev, not a vanity domain from that draft.

## Configuration

`--public` shares are peer-to-peer with STUN only by default. If viewers sit behind symmetric NATs and get stuck on "waiting for host", add a TURN relay. ICE config is set on the host and sent to viewers over signaling.

Precedence, highest first:

1. `--ice-servers '<json>'`
2. `VIBESHARE_ICE_SERVERS`
3. `~/.vibeshare/config.json` → `"iceServers"`
4. default: `[{ "urls": "stun:stun.l.google.com:19302" }]`

```jsonc
// ~/.vibeshare/config.json
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

Malformed flag or env JSON is reported and skipped. Resolution falls through. It does not break the share.

MCP setup, including the Windows `cmd /c npx` wrap, is in [`docs/SETUP.md`](docs/SETUP.md).

## FAQ

<details>
<summary>How do I share from an npm library?</summary>

```ts
import { createShare, grantConsent } from 'vibeshare-live';

grantConsent('share from my tool');
const { url, feed, viewers, revoke } = await createShare({
  session: 'npm test',
  access: 'spectate',
  expiry: '1h',
});

feed.publish('tests starting…');
viewers.on('request', (v) => viewers.approve(v.id));
await revoke();
```

`createShare` throws `ConsentRequiredError` without a `share:session` grant. Bring your own plumbing with `ShareManager`, `LocalHttpTransport`, and `FileConsentStore`.

</details>

<details>
<summary>How does the MCP server work?</summary>

```json
{
  "mcpServers": {
    "vibeshare": { "command": "vibeshare-mcp" }
  }
}
```

Tools: `vibeshare_create`, `vibeshare_viewers`, `vibeshare_stop`. An agent can offer "share this session?". The MCP client's tool-approval prompt is the consent act. Approving join requests stays human-only, via the CLI.

</details>

## Contributing

See [CONTRIBUTING.md](https://github.com/pooriaarab/.github/blob/main/CONTRIBUTING.md).

## License

[MIT](LICENSE)
