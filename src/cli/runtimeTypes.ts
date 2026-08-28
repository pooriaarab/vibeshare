import type { ActiveShareRecord } from '../consent.js';
import type { CreatedShare } from '../manager.js';
import { ShareManager } from '../manager.js';

export type SessionInputSink = (data: string) => void;

export interface IO {
  out(text: string): void;
  err(text: string): void;
}

export interface ShareRuntime {
  created: CreatedShare;
  manager: ShareManager;
  record: ActiveShareRecord;
  tunnelHandle: { url: string; stop(): Promise<void> } | null;
  watcher: { stop(): void };
  tunnelOn: boolean;
  tunnelProviderName: string | null;
  setInputSink(sink: SessionInputSink | null): void;
  cleanup(): Promise<void>;
}
