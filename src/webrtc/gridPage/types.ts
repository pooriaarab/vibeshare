/** One share slot decoded from the grid URL fragment. */
export interface GridShareRef {
  readonly id: string;
  /** base64url AES-256-GCM key (URL fragment form). */
  readonly key: string;
}
