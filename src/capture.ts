/**
 * CaptureSource — the one seam between "how we get terminal bytes" and
 * "how we share them".
 *
 * PTY spawn (`vibeshare -- <cmd>`) and tmux attach (`vibeshare attach`) are
 * both capture sources. Everything downstream — SessionFeed, transports,
 * xterm viewer, e2e, presence/chat — stays unchanged.
 *
 * A source is responsible for:
 *   1. Publishing an initial resize (so viewers `term.resize` before bytes)
 *   2. Publishing any backlog (e.g. tmux capture-pane screen)
 *   3. Streaming live raw bytes via `feed.publishRaw`
 *   4. Cleaning up on stop (kill PTY, `tmux pipe-pane` off, remove fifo, …)
 *
 * Collaborator input (when the host approves a viewer on an `--invite`
 * share) is applied by the host CLI via optional `CaptureHandle.writeInput`
 * (PTY stdin write, or tmux send-keys for attach). The write gate is always
 * `ViewerRegistry.canWrite()` in the transport — never the capture source.
 */
import type { SessionFeed } from './feed.js';

/** Minimal feed surface a capture source needs — keeps tests light. */
export interface CaptureFeed {
  publishRaw(data: string | Buffer | Uint8Array): unknown;
  publishResize(cols: number, rows: number): unknown;
}

/** Running capture; call stop() to tear down (idempotent). */
export interface CaptureHandle {
  /** Human label used for share name / logs. */
  readonly label: string;
  /** End capture and release OS resources. Safe to call more than once. */
  stop(): Promise<void>;
  /**
   * Apply approved collaborator input to the live session (PTY stdin or
   * tmux send-keys). Optional — sources that are capture-only omit it.
   */
  writeInput?(data: string): void | Promise<void>;
}

/**
 * Something that can push terminal bytes into a SessionFeed.
 * Implementations must not touch transports, URLs, or consent.
 */
export interface CaptureSource {
  /** Start capturing into `feed`. Resolves once backlog + live pipe are up. */
  start(feed: CaptureFeed | SessionFeed): Promise<CaptureHandle>;
}
