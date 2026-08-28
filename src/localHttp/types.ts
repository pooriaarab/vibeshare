import type { ServerResponse, IncomingMessage } from 'node:http';
import type { SessionFeed } from '@pooriaarab/vibe-core/feed';
import type { ViewerRegistry } from '../registry.js';
import type { Share, Viewer } from '../types.js';
import type { ChatRelayFrame } from '../presenceChat.js';
import type { AnnotationRelayFrame } from '../annotations.js';

export interface LocalHttpTransportOptions {
  /** Bind address. Default 127.0.0.1 (loopback-only). Use 0.0.0.0 for LAN. */
  readonly host?: string;
  /** Port. Default 0 = ephemeral. */
  readonly port?: number;
  /**
   * Public base URL to print instead of `http://host:port` — the seam where
   * a future RelayTransport hands out `https://vibeshare.io` URLs. Routing
   * still happens locally.
   */
  readonly baseUrl?: string;
  /** Bearer token for the loopback control API. Generated when omitted. */
  readonly hostToken?: string;
  /**
   * Called when the control API asks to stop a share (e.g. `vibeshare stop`
   * from another process). When absent, the transport unserves + closes the
   * feed itself.
   */
  readonly onStopRequested?: (shareId: string) => void;
  /**
   * Opt-in end-to-end encryption for the spectator path (used by `--tunnel`).
   * When set:
   *   - every SSE event's data payload is `encryptFrame(key, …)` encoded as
   *     standard base64 (the tunnel provider sees only ciphertext);
   *   - the spectator page decrypts via WebCrypto using the key from the
   *     share URL `#fragment`.
   * When absent (the default pure-local loopback path) behaviour is
   * unchanged — plaintext SSE, existing tests stay green.
   */
  readonly e2e?: { readonly key: Buffer };
  /**
   * Incoming chat lines (already decrypted when e2e is on) for the host
   * terminal. Identity is stamped from the viewer token — never the payload.
   */
  readonly onChat?: (shareId: string, frame: { viewerId: string; name: string; text: string }) => void;
  /**
   * Incoming annotations (already decrypted when e2e is on) for the host
   * terminal. Identity is stamped from the viewer token — never the payload;
   * `seq` is the feed anchor the viewer pinned.
   */
  readonly onAnnotation?: (
    shareId: string,
    frame: { viewerId: string; name: string; seq: number; text: string; replyTo?: string },
  ) => void;
  /**
   * Gated collaborator input. Called only after the viewer token resolves and
   * `viewers.canWrite(viewerId)` is true. Identity is never taken from the body.
   */
  readonly onInput?: (shareId: string, viewerId: string, data: string) => void;
  /**
   * Fired when a viewer requests to join (invite shares). Host CLI prints a
   * one-line approve hint. Identity from the registry row.
   */
  readonly onJoinRequest?: (shareId: string, viewer: Viewer) => void;
}

export interface ShareContext {
  share: Share;
  feed: SessionFeed;
  viewers: ViewerRegistry;
  /** Open SSE connections, grouped by viewer id. */
  streams: Map<string, Set<ServerResponse>>;
}

export interface RouteContext {
  readonly ctx: ShareContext;
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly url: URL;
  readonly e2eKey?: Buffer;
  readonly onChat?: (shareId: string, frame: { viewerId: string; name: string; text: string }) => void;
  readonly onAnnotation?: (
    shareId: string,
    frame: { viewerId: string; name: string; seq: number; text: string; replyTo?: string },
  ) => void;
  readonly onInput?: (shareId: string, viewerId: string, data: string) => void;
  readonly openStream: (viewer: Viewer, res: ServerResponse) => void;
  readonly broadcastChat: (frame: ChatRelayFrame) => void;
  readonly broadcastAnnotation: (frame: AnnotationRelayFrame) => void;
  readonly roster: () => import('../presenceChat.js').PresenceEntry[];
}

export interface ControlContext {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly url: URL;
  readonly shares: Map<string, ShareContext>;
  readonly onStop?: (shareId: string) => void;
  readonly mustCtx: (shareId: string) => ShareContext;
  readonly unserve: (shareId: string) => Promise<void>;
}
