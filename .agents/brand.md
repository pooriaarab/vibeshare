# vibeshare brand

## Identity

vibeshare is a local-first tool for sharing a live terminal session by URL.
It belongs to the Vibe Suite.

The product ships as a CLI, npm package, and MCP server. Recipients watch the
session in a browser. An approved recipient can drive an invite-mode session.

## Audience

The primary audience is developers who use agentic coding tools and want to
share a live terminal without sharing a desktop.

The secondary audience is pairing partners and reviewers who need a browser
view, chat, annotations, or host-approved input.

## Promise

Use this primary message: **Share your live agent coding session by URL.**

Support it with these verified points:

- The default local share is served from the host machine.
- Public mode sends session frames directly over encrypted WebRTC.
- The public rendezvous handles signaling, not session plaintext.
- Tunnel mode encrypts content before it crosses the tunnel provider.
- Spectators cannot write until the host approves them.
- A local consent record gates every share.

## Voice

Write direct, calm, technical copy. Put the access state and privacy boundary
near the link or action they describe.

Use concrete terms such as `local`, `p2p`, `read-only`, and `end-to-end
encrypted`. Explain which mode each term covers.

Do not replace security details with broad trust claims.

## Naming

- Use **vibeshare** for the product and executable.
- Use `vibeshare-live` for the npm package.
- Use `vibeshare-mcp` for the MCP executable alias.
- Use **Vibe Suite** for the related product family.
- Use `@pooriaarab/vibe-core` for the shared dependency.
- Use `vibelive` only when describing the multiplayer seam.

## Claims

Treat current source and tests as the authority for shipped behavior.

The share URL is a capability. Anyone with a valid link can request the access
that its mode permits. A passphrase adds a second factor when configured.

Public mode puts the encryption key in the URL fragment. Browsers do not send
that fragment to the signaling service.

The host enforces write access through `ViewerRegistry.canWrite()`. A disabled
browser control is not the security boundary.

Do not use `docs/spec.md` domain examples as current production claims. Current
public links use the configured Vibe Suite path.

## Assets

`branding/logo.png` is the product logo. It is a 400-pixel square with a teal
field, white broadcast arcs, and a white paper-plane mark.

`branding/launch-video.mp4` and `branding/launch-video-9x16.mp4` are the current
launch videos. Their HTML source files live in `docs/`.

Keep the logo geometry intact. Do not redraw it from memory.

## Avoid

- Do not call every mode peer-to-peer.
- Do not imply that the signaling service carries session plaintext.
- Do not promise anonymity or protection from a recipient who can view.
- Do not describe invite mode as automatic remote control.
- Do not use an unshipped vanity domain in current instructions.
