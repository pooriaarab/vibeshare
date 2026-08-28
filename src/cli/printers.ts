import { sanitizePeerText } from '@pooriaarab/vibe-core';
import type { Viewer } from '../types.js';
import type { IO, SessionInputSink } from './runtimeTypes.js';

export type PrinterBag = {
  printChat: (name: string, text: string) => void;
  printAnnotation: (name: string, seq: number, text: string) => void;
  printJoinRequest: (shareId: string, viewer: Viewer) => void;
  applyInput: SessionInputSink;
  setSink: (s: SessionInputSink | null) => void;
};

export function makePrinters(io: IO): PrinterBag {
  let inputSink: SessionInputSink | null = null;
  const printChat = (name: string, text: string): void => {
    const who = sanitizePeerText(name, 32).trim() || 'viewer';
    const msg = sanitizePeerText(text, 500);
    if (!msg) return;
    io.err(`\r\x1b[2m[chat] ${who}: ${msg}\x1b[0m`);
  };
  const printAnnotation = (name: string, seq: number, text: string): void => {
    const who = sanitizePeerText(name, 32).trim() || 'viewer';
    const msg = sanitizePeerText(text, 500);
    if (!msg) return;
    io.err(`\r\x1b[2m[annotation @${seq}] ${who}: ${msg}\x1b[0m`);
  };
  const printJoinRequest = (_shareId: string, viewer: Viewer): void => {
    const who = sanitizePeerText(viewer.name, 32).trim() || 'viewer';
    io.err(`\r\x1b[2m[join] ${who} wants to drive — approve: vibeshare viewers --approve ${viewer.id}\x1b[0m`);
  };
  const applyInput: SessionInputSink = (data) => {
    try { inputSink?.(data); } catch { /* closed */ }
  };
  return {
    printChat,
    printAnnotation,
    printJoinRequest,
    applyInput,
    setSink: (s) => { inputSink = s; },
  };
}
