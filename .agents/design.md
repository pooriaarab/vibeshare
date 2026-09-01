---
schema: design-context/v1
surface: product-ui
sources:
  - src/xtermClient.ts
  - src/spectatorPage/shell.ts
  - src/webrtc/viewerPage/shell.ts
  - src/webrtc/gridPage/html.ts
  - src/webrtc/canvasPage/html.ts
  - src/cli/runtime.ts
  - branding/logo.png
---

# vibeshare design context

## Overview

vibeshare has two shipped surfaces. The browser surface shows one or more live
terminals. The CLI creates and manages shares.

`src/xtermClient.ts` imports the shared terminal chrome from
`@pooriaarab/vibe-core/xterm`. Page templates add spectator, viewer, grid, and
canvas behavior.

This repository has no canonical custom production home in
`.agents/context.yaml`. Do not add `/design.md` or `/brand` routes here.

## Colors

The browser uses these semantic tokens from the imported xterm chrome:

- Canvas: `--bg` at `#0a0b0f`.
- Panels: `--panel` at `#12141a`, `--panel-2` at `#171a22`, and `--panel-3` at `#1d2129`.
- Borders: eight-percent and fourteen-percent white.
- Text: `--text` at `#edeef3`, `--dim` at `#9aa0b2`, and `--faint` at `#666c7c`.
- Active and focus state: `--cyan` at `#67e8f9`.
- Collaborator state: `--violet` at `#c4b5fd`.
- Live or success state: `--green` at `#7ee787`.
- Ended or error state: `--red` at `#ff8b85`.

Only a dark browser theme ships. Pair every state color with text, a shape, or
an icon.

The teal logo palette is separate from browser status colors. Sample the asset
when an exact logo value is required.

## Typography

Browser prose uses the system sans stack. Terminal data, paths, chat, badges,
and identifiers use the shared monospace stack.

The wordmark is `17px` at weight `650`. Panel titles are `15px`. Buttons are
`13px` at weight `600`. Metadata ranges from `11.5px` to `12.5px`.

xterm renders the shared session's own colors and type. Do not restyle terminal
content as application prose.

CLI summaries use aligned lowercase labels. Chat, annotation, and join notices
use dim ANSI text and a reset code.

## Layout

The standard browser app has an `1100px` maximum width. Its desktop padding is
`22px` horizontally and `26px` vertically.

Padding and terminal height reduce at `900px`, `639px`, and `380px`. Forms stack
and controls reach `44px` height on phones.

The grid uses one column by default. It uses two columns from `640px`, three
from `1100px`, and four from `1600px`.

The canvas uses a pannable viewport. Below `640px`, a card is the viewport width
minus `48px`, capped at `340px`.

CLI summaries put one field on each line. Keep `sharing`, `url`, `access`,
`expires`, `mode`, and `manage` aligned.

## Elevation & Depth

Base panels use flat fills and one-pixel borders. The terminal stays on the
darkest inner surface.

Grid expansion uses a dark page backdrop and a deep shadow. Canvas cards use a
smaller shadow to separate draggable sessions from the board.

CLI depth is not applicable because its owned output is text.

## Shapes

Panels, chat logs, terminal frames, and session cards use a `12px` radius.
Buttons and inputs use `8px`. Font controls use `6px`.

Status badges use a pill shape. Connection dots and terminal-window controls
are circular.

Use the paper-plane and broadcast-arc mark from `branding/logo.png`. Do not
replace it with generic link or screen-share artwork.

## Components

- The top bar pairs the wordmark with an explicit connection or privacy badge.
- The terminal frame keeps font controls named with `aria-label` attributes.
- The watch panel asks for a display name before opening a public stream.
- Presence controls expose expansion state through `aria-expanded`.
- Invite controls show request, pending, and approved states.
- Disabled input remains disabled until host approval reaches the client.
- Chat and annotations keep separate headings and scroll regions.
- Grid cells pair a colored dot with a written connection state.
- Canvas cells use their header as the drag handle.
- Expanded grid cells keep a backdrop and visible focus outline.
- Motion stays brief. Do not animate terminal content added by the shared session.

## Do's and Don'ts

- Do show the access mode beside every new share link.
- Don't present invite mode as unrestricted write access.
- Do use semantic tokens for shared browser chrome.
- Don't change xterm output colors to match application accents.
- Do preserve phone stacking and `44px` touch controls.
- Don't hide focus, pending, ended, or disabled states.
- Do keep URL fragments out of displayed logs and server requests.
- Don't use the logo teal as an undocumented connection state.
