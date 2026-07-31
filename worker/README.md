# vibeshare-signaling

The vibeshare signaling rendezvous: a Cloudflare Worker + one Durable Object
per shareId. It carries ONLY the WebRTC offer/answer/ICE handshake between a
`vibeshare --public` host and browser viewers. Session bytes stay
peer-to-peer over an AES-256-GCM DataChannel; the key lives only in the share
URL `#fragment` and is never sent to this Worker.

Security model (the Worker is the identity authority):

- viewerIds are minted by the Worker (`crypto.randomUUID`), one per viewer
  socket — a viewer cannot choose or claim another viewer's id;
- every relayed frame is stamped with the connection's own
  `(shareId, viewerId, from)` — client-supplied identity fields are discarded;
- the host authenticates with a host-secret minted when the share is created
  (first secret seen for a share is bound durably; later host connections
  must match; viewers never see it);
- the relay is a whitelist: only `rtc-offer` / `rtc-answer` / `rtc-ice` are
  forwarded, reconstructed server-side. Everything else is dropped.

## Routes

| Route | Purpose |
| --- | --- |
| `GET /vibeshare/s/<id>` | the self-contained viewer page (reads `#key` from the URL fragment) |
| `GET /vibeshare/ws/host?share=<id>&secret=<s>` | host signaling socket |
| `GET /vibeshare/ws/viewer?share=<id>` | viewer signaling socket |
| `GET /vibeshare/health` | liveness |

The client halves of this protocol live in `../src/webrtc/wsSignaling.ts`
(host, Node) and `../src/webrtc/viewerPage.ts` (viewer, browser).

## Run locally

```sh
npm install      # once — wrangler + types
npm run dev      # http://localhost:8787 (no Cloudflare account needed)
```

Then point a local `vibeshare` at it:

```sh
VIBESHARE_SIGNALING=ws://localhost:8787/vibeshare vibeshare --public --yes
# or persistently: ~/.vibeshare/config.json → { "signalingUrl": "ws://localhost:8787/vibeshare" }
```

The printed share URL will be `http://localhost:8787/vibeshare/s/<id>#<key>`
— open it in a browser to watch.

## Deploy (human-owned)

1. Uncomment the `routes` block in `wrangler.toml`
   (`getvibe.dev/vibeshare/*` on the `getvibe.dev` zone).
2. `npx wrangler login` (once).
3. `npm run deploy`.

Self-hosters can deploy this same Worker to their own Cloudflare account (or
reimplement the small protocol) and set `signalingUrl` /
`VIBESHARE_SIGNALING` / `--signaling` to their endpoint — nothing is locked
to getvibe.dev.
