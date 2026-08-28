/** One share slot decoded from the canvas URL fragment (with board position). */
export interface CanvasShareRef {
  readonly id: string;
  /** base64url AES-256-GCM key (URL fragment form). */
  readonly key: string;
  /** Integer board x (CSS px on the unscaled board). */
  readonly x: number;
  /** Integer board y (CSS px on the unscaled board). */
  readonly y: number;
}
