/**
 * Bindings for the vibeshare signaling Worker (mirrored in wrangler.toml).
 * The only binding is the durable `SHARES` namespace: one ShareRoom DO per
 * shareId carries the WebRTC handshake.
 */
export interface Env {
  readonly SHARES: DurableObjectNamespace;
}