export type TranscriptAgent = 'claude' | 'codex';

export interface TranscriptEvent {
  seq: number;
  ts?: number;
  role: 'user' | 'assistant' | 'system' | 'tool';
  kind: 'prompt' | 'response' | 'thinking' | 'tool_use' | 'tool_result' | 'system';
  /** Text is redacted and length-capped before an event is returned. */
  text: string;
  tool?: { name: string; input?: string };
  agent: TranscriptAgent;
}
