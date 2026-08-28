import { randomBytes } from 'node:crypto';
import { WebSocket } from 'ws';
import type { SignalingFrame } from './signaling.js';
import { pairKey } from './wsSignalingValidation.js';

export interface HostConn {
  readonly shareId: string;
  readonly secret: string;
  readonly ws: WebSocket;
  open: boolean;
  closing: boolean;
  readonly outbox: string[];
  readonly watchers: Set<(viewerId: string) => void>;
  readonly hostSubs: Map<string, Set<(frame: SignalingFrame) => void>>;
  refs: number;
  /** Host display name announced via hello (default "host"). */
  name: string;
}

export interface ViewerConn {
  readonly shareId: string;
  readonly localViewerId: string;
  readonly ws: WebSocket;
  open: boolean;
  closing: boolean;
  readonly outbox: string[];
  assignedViewerId: string | null;
  readonly viewerSubs: Set<(frame: SignalingFrame) => void>;
}

const OUTBOX_CAP = 256;

export class WsConnectionManager {
  readonly hosts = new Map<string, HostConn>();
  readonly viewers = new Map<string, ViewerConn>();

  constructor(
    private readonly base: string,
    private readonly onError: (err: Error) => void,
    private readonly onHostMessage: (conn: HostConn, text: string) => void,
    private readonly onViewerMessage: (conn: ViewerConn, text: string) => void,
  ) {}

  hostConn(shareId: string): HostConn {
    const existing = this.hosts.get(shareId);
    if (existing) return existing;

    const secret = randomBytes(16).toString('hex');
    const ws = new WebSocket(
      `${this.base}/ws/host?share=${encodeURIComponent(shareId)}&secret=${secret}`,
    );
    const conn: HostConn = {
      shareId,
      secret,
      ws,
      open: false,
      closing: false,
      outbox: [],
      watchers: new Set(),
      hostSubs: new Map(),
      refs: 0,
      name: 'host',
    };
    this.hosts.set(shareId, conn);

    ws.on('open', () => {
      conn.open = true;
      this.flush(conn);
      this.send(conn, { kind: 'hello', name: conn.name });
    });
    ws.on('message', (data: WebSocket.RawData) => this.onHostMessage(conn, String(data)));
    ws.on('error', (err: Error) => this.onError(err));
    ws.on('close', () => {
      conn.open = false;
      if (!conn.closing) this.onError(new Error(`signaling host socket for share ${shareId} closed`));
    });

    return conn;
  }

  viewerConn(shareId: string, viewerId: string): ViewerConn {
    const key = pairKey(shareId, viewerId);
    const existing = this.viewers.get(key);
    if (existing) return existing;

    const ws = new WebSocket(`${this.base}/ws/viewer?share=${encodeURIComponent(shareId)}`);
    const conn: ViewerConn = {
      shareId,
      localViewerId: viewerId,
      ws,
      open: false,
      closing: false,
      outbox: [],
      assignedViewerId: null,
      viewerSubs: new Set(),
    };
    this.viewers.set(key, conn);

    ws.on('open', () => {
      conn.open = true;
      this.flush(conn);
    });
    ws.on('message', (data: WebSocket.RawData) => this.onViewerMessage(conn, String(data)));
    ws.on('error', (err: Error) => this.onError(err));
    ws.on('close', () => {
      conn.open = false;
      if (!conn.closing) this.onError(new Error(`signaling viewer socket for share ${shareId} closed`));
    });

    return conn;
  }

  closeHost(shareId: string): void {
    const conn = this.hosts.get(shareId);
    if (!conn) return;
    this.hosts.delete(shareId);
    conn.closing = true;
    conn.watchers.clear();
    conn.hostSubs.clear();
    try {
      conn.ws.close();
    } catch {
      // ignore
    }
  }

  closeViewerIfIdle(conn: ViewerConn): void {
    if (conn.viewerSubs.size > 0) return;
    if (this.viewers.get(pairKey(conn.shareId, conn.localViewerId)) !== conn) return;
    this.viewers.delete(pairKey(conn.shareId, conn.localViewerId));
    conn.closing = true;
    try {
      conn.ws.close();
    } catch {
      // ignore
    }
  }

  sendHost(shareId: string, msg: Record<string, unknown>): void {
    const conn = this.hosts.get(shareId);
    if (!conn) return;
    this.send(conn, msg);
  }

  sendViewer(shareId: string, viewerId: string, msg: Record<string, unknown>): void {
    const conn = this.viewers.get(pairKey(shareId, viewerId));
    if (!conn) return;
    this.send(conn, msg);
  }

  send(conn: HostConn | ViewerConn, msg: Record<string, unknown>): void {
    const text = JSON.stringify(msg);
    if (conn.open) {
      conn.ws.send(text);
    } else if (conn.outbox.length < OUTBOX_CAP) {
      conn.outbox.push(text);
    }
  }

  flush(conn: HostConn | ViewerConn): void {
    for (const text of conn.outbox.splice(0)) conn.ws.send(text);
  }

  close(): void {
    for (const shareId of Array.from(this.hosts.keys())) {
      this.closeHost(shareId);
    }
    for (const conn of this.viewers.values()) {
      conn.closing = true;
      try {
        conn.ws.close();
      } catch {
        // already closed
      }
    }
    this.viewers.clear();
  }
}
