import { readJsonBody, sendJson, streamCount, publicViewer } from './helpers.js';
import type { ControlContext } from './types.js';

async function handleControlShares(cCtx: ControlContext): Promise<Record<string, unknown> | undefined> {
  return {
    shares: [...cCtx.shares.values()].map((c) => ({
      id: c.share.id,
      name: c.share.name,
      access: c.share.access,
      state: c.share.state,
      watching: streamCount(c),
    })),
  };
}

async function handleControlViewers(cCtx: ControlContext): Promise<Record<string, unknown> | undefined> {
  const shareId = cCtx.url.searchParams.get('share') ?? '';
  const ctx = cCtx.mustCtx(shareId);
  return {
    viewers: ctx.viewers.list().map(publicViewer),
    watching: streamCount(ctx),
  };
}

async function handleControlViewerAction(
  cCtx: ControlContext,
  action: 'approve' | 'deny' | 'kick',
): Promise<Record<string, unknown> | undefined> {
  const { req, res } = cCtx;
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'method not allowed' });
    return undefined;
  }
  const body = await readJsonBody(req);
  const shareId = typeof body['share'] === 'string' ? body['share'] : '';
  const ctx = cCtx.mustCtx(shareId);
  const viewerId = typeof body['viewer'] === 'string' ? body['viewer'] : '';
  return {
    viewer: publicViewer(ctx.viewers[action](viewerId)),
  };
}

async function handleControlApprove(cCtx: ControlContext): Promise<Record<string, unknown> | undefined> {
  return handleControlViewerAction(cCtx, 'approve');
}

async function handleControlDeny(cCtx: ControlContext): Promise<Record<string, unknown> | undefined> {
  return handleControlViewerAction(cCtx, 'deny');
}

async function handleControlKick(cCtx: ControlContext): Promise<Record<string, unknown> | undefined> {
  return handleControlViewerAction(cCtx, 'kick');
}

async function handleControlStop(cCtx: ControlContext): Promise<Record<string, unknown> | undefined> {
  const { req, res, onStop, mustCtx, unserve } = cCtx;
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'method not allowed' });
    return undefined;
  }
  const body = await readJsonBody(req);
  const shareId = typeof body['share'] === 'string' ? body['share'] : '';
  const ctx = mustCtx(shareId);
  sendJson(res, 200, { stopped: shareId });
  if (onStop) {
    onStop(shareId);
  } else {
    await unserve(shareId);
    ctx.feed.close();
  }
  return undefined;
}

export const CONTROL_HANDLERS: Record<
  string,
  (cCtx: ControlContext) => Promise<Record<string, unknown> | undefined>
> = {
  '/control/shares': handleControlShares,
  '/control/viewers': handleControlViewers,
  '/control/approve': handleControlApprove,
  '/control/deny': handleControlDeny,
  '/control/kick': handleControlKick,
  '/control/stop': handleControlStop,
};
export { handleControlShares, handleControlViewers, handleControlApprove, handleControlDeny, handleControlKick, handleControlStop };
