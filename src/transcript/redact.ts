const MAX_EVENT_TEXT = 4000;
const TRUNCATION_MARKER = '… [truncated]';

const PEM_BLOCK = /-----BEGIN [A-Z0-9 ]+-----[\s\S]*?-----END [A-Z0-9 ]+-----/g;
const BEARER_TOKEN = /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi;
const SENSITIVE_ASSIGNMENT =
  /\b((?:[A-Za-z_][A-Za-z0-9_]*?)?(?:SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|PRIVATE|CREDENTIAL)[A-Za-z0-9_]*)\s*(=|:)\s*(?:"([^"]*)"|'([^']*)'|`([^`]*)`|([^\s"'`,;}\]]+))/gi;
const KNOWN_TOKEN_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bgithub_pat_[A-Za-z0-9_]+/g, 'github-token'],
  [/\bghp_[A-Za-z0-9]+/g, 'github-token'],
  [/\bxox[baprs]-[A-Za-z0-9-]+/g, 'slack-token'],
  [/\bsk-ant-[A-Za-z0-9_-]+/g, 'api-key'],
  [/\bsk-[A-Za-z0-9_-]+/g, 'api-key'],
  [/\bAKIA[0-9A-Z]{16}\b/g, 'aws-key'],
  [/\bASIA[0-9A-Z]{16}\b/g, 'aws-key'],
  [/\bAIza[A-Za-z0-9_-]{20,}/g, 'google-key'],
];
const BLOB = /(?<![A-Za-z0-9+/=_-])[A-Za-z0-9+/=_-]{32,}(?![A-Za-z0-9+/=_-])/g;

/**
 * Rebuild a redacted `KEY=value` assignment from the SENSITIVE_ASSIGNMENT capture
 * groups, keeping whichever quote style the original used. `String.replace` appends
 * the match offset and the whole subject after the groups, so read positionally and
 * ignore anything that is not a string.
 */
function maskAssignment(groups: readonly unknown[]): string {
  const group = (index: number): string | undefined => {
    const value = groups[index];
    return typeof value === 'string' ? value : undefined;
  };
  const quote = group(2) !== undefined ? '"' : group(3) !== undefined ? "'" : group(4) !== undefined ? '`' : '';
  return `${group(0) ?? ''}${group(1) ?? ''}${quote}${marker('secret')}${quote}`;
}

function marker(label: string): string {
  return `«redacted:‹${label}›»`;
}

function entropy(value: string): number {
  const counts = new Map<string, number>();
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1);
  let result = 0;
  for (const count of counts.values()) {
    const probability = count / value.length;
    result -= probability * Math.log2(probability);
  }
  return result;
}

function isHighEntropyBlob(value: string): boolean {
  if (value.length < 32) return false;
  const hex = /^[0-9a-f]+$/i.test(value);
  if (hex && new Set(value.toLowerCase()).size >= 8) return true;
  const classes = [/[a-z]/.test(value), /[A-Z]/.test(value), /\d/.test(value), /[+/=_-]/.test(value)];
  return classes.filter(Boolean).length >= 3 && entropy(value) >= 3.5;
}

/**
 * Redact likely credentials from transcript text before it can enter an event
 * or be published to a viewer. This intentionally errs toward over-masking.
 */
export function redact(text: string): string {
  let output = text
    .replace(PEM_BLOCK, marker('pem'))
    .replace(BEARER_TOKEN, (match) => `Bearer ${marker('bearer-token')}`)
    .replace(SENSITIVE_ASSIGNMENT, (_match: string, ...groups: unknown[]) =>
      maskAssignment(groups),
    );

  for (const [pattern, label] of KNOWN_TOKEN_PATTERNS) {
    output = output.replace(pattern, marker(label));
  }
  output = output.replace(BLOB, (match) => (isHighEntropyBlob(match) ? marker('high-entropy') : match));

  if (output.length <= MAX_EVENT_TEXT) return output;
  return output.slice(0, MAX_EVENT_TEXT - TRUNCATION_MARKER.length) + TRUNCATION_MARKER;
}
