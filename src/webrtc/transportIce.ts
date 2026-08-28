import type { RTCIceServer } from '../config.js';

/**
 * Map host ICE config to the string form node-datachannel accepts
 * (`stun:host:port` / `turn:user:pass@host:port?transport=tcp` — verified
 * against node-datachannel 0.32.x, which rejects the browser object shape).
 * Plain string entries pass through untouched; TURN objects get
 * `username`/`credential` embedded into each `turn:`/`turns:` URL.
 */
export function toNodeIceServers(servers: readonly (string | RTCIceServer)[]): string[] {
  const out: string[] = [];
  for (const server of servers) {
    if (typeof server === 'string') {
      out.push(server);
      continue;
    }
    const urls = typeof server.urls === 'string' ? [server.urls] : server.urls;
    for (const url of urls) out.push(embedTurnCredentials(url, server.username, server.credential));
  }
  return out;
}

/** Insert `user[:pass]@` into a TURN URL; non-TURN URLs pass through. */
export function embedTurnCredentials(url: string, username?: string, credential?: string): string {
  if (username === undefined || username.length === 0) return url;
  if (url.includes('@')) return url; // already carries credentials
  const m = /^(turns?:)(\/\/)?(.*)$/.exec(url);
  if (!m) return url; // not a TURN URL — credentials don't apply
  const [, scheme = '', slashes = '', rest = ''] = m;
  const cred = credential !== undefined && credential.length > 0 ? `${username}:${credential}` : username;
  return `${scheme}${slashes}${cred}@${rest}`;
}

/**
 * Wire form for the rtc-ice-servers frame: every entry becomes an
 * RTCIceServer object. A string entry becomes `{ urls }` — except a TURN URL
 * with embedded credentials (`turn:user:pass@host:port`), which browsers
 * reject inside `urls`; those are split into username/credential fields.
 */
export function iceServersForWire(servers: readonly (string | RTCIceServer)[]): RTCIceServer[] {
  return servers.map((s) => (typeof s === 'string' ? serverStringForWire(s) : s));
}

export function serverStringForWire(url: string): RTCIceServer {
  const m = /^(turns?:)(\/\/)?([^:/@]+):([^@]*)@(.*)$/.exec(url);
  if (!m) return { urls: url };
  const [, scheme = '', slashes = '', username = '', credential = '', rest = ''] = m;
  const server: { urls: string; username: string; credential?: string } = {
    urls: `${scheme}${slashes}${rest}`,
    username,
  };
  if (credential.length > 0) server.credential = credential;
  return server;
}
