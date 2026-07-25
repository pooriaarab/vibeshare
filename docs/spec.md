# vibeshare — spec

Status: DRAFT (Opus-authored) · 2026-07-25 · depends on `@vibe/core` + vibelive
Identity: vibeshare.stream (available $4/yr — its OWN domain, not vibe.live) · CLI + npm + MCP
Prior art: traces.com (but open source, CLI-first) · Happy (slopus/happy) transport

## What it is
Share your **live** agent coding session by URL. The distribution layer on top of
**vibelive** (the multiplayer engine): a link that lets people **spectate read-only**
or be **invited into the live multiplayer session**.

## Relationship to vibelive
- **vibelive** = the engine (transport, presence, cursors, chat, write-arbitration).
- **vibeshare** = the URL/identity/access layer: create a shareable link, set access
  policy, let viewers request to join → hands off into vibelive.
- A spectator is a vibelive participant with read-only + no cursor-write; "join"
  promotes them to a full participant. vibeshare owns the *link + gate*, vibelive
  owns the *session*.

## The flow
1. `vibeshare` in your terminal → generates `vibeshare.io/s/<id>` (its own domain).
2. Access policy: **spectate** (read-only) ↔ **invite** (can join to collaborate);
   expiry (1h / 24h / until I stop); optional passphrase.
3. Recipients open the URL → read-only live view of your terminal (agent output
   streams via vibelive's ordered-log channel). "Request to join" → host approves →
   promoted into the live session.

## Local-first / transport (inherits vibelive §1-2)
Session streamed **peer-to-peer / via a dumb e2e-encrypted relay** — the relay
forwards opaque blobs, **nothing readable stored on a server**, relay self-hostable.
Badge: "● p2p · e2e · nothing stored on a server". `share:session` consent grant
required (§4). Spectator-heavy sharing = pub/sub fan-out tier (scales to the vibelive
1,000 spectator target).

## Access / safety
- Link is a capability URL (unguessable id); passphrase optional second factor.
- Read-only spectators genuinely can't write (enforced server-of-record = host, not
  UI-only) — same write-arbitration invariant as vibelive §4.
- Revoke link / kick viewer / lock to invite-only, live.
- Expiry auto-tears down the relay subscription.

## Surfaces
- **CLI:** `vibeshare [--spectate|--invite] [--expire 1h] [--pass]` → prints URL ·
  `vibeshare stop` · `vibeshare viewers` (see/kick/approve).
- **npm:** `createShare({session, access, expiry})` → `{url, revoke}`.
- **MCP:** `vibeshare.create`, `vibeshare.viewers` — agent can offer "share this
  session?"
- **Web spectator view:** the URL target — a minimal read-only vibelive client
  (self-contained, no install for viewers).

## Cross-harness
Wraps whatever agent vibelive is hosting (Claude Code / Codex / Cursor / Gemini /
Grok / pi / Kimi / …). Harness-agnostic via vibelive.

## Open questions
- Web spectator client hosting: served from the self-hostable relay, or a static
  page + relay data channel? Prefer static page (any host / IPFS) + e2e relay data,
  so "open source, self-host everything" holds.
- Public/discoverable shares (a directory of live sessions) vs link-only — v0 =
  link-only (privacy default); discovery opt-in later.
- Recording a shared session to replay (→ vibemovie handoff) — v2.
