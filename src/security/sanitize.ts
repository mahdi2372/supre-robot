/**
 * Security: recursive redaction of sensitive values before anything touches
 * the audit-log table or structured logs. Defense in depth — the pino redact
 * list also covers process logs, but admin-provided log payloads must be
 * scrubbed independently.
 */

const SENSITIVE_KEY =
  /(token|secret|password|passphrase|api[_-]?key|apikey|authorization|cookie|credential|private[_-]?key|session)/i;

const MAX_DEPTH = 8;
const MAX_ARRAY_ITEMS = 50;
const MAX_STRING = 2000;

export function sanitizeForLog(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return '[truncated]';
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.length > MAX_STRING ? value.slice(0, MAX_STRING) + '…' : value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'function' || typeof value === 'symbol') return '[unserializable]';
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY_ITEMS).map((v) => sanitizeForLog(v, depth + 1));
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEY.test(k)) {
        out[k] = '[REDACTED]';
      } else {
        out[k] = sanitizeForLog(v, depth + 1);
      }
    }
    return out;
  }
  return String(value);
}

/**
 * Wrap an async handler so unexpected rejections are logged (with redaction)
 * and converted into a stable failure value instead of crashing the process.
 * Used for "best effort" side effects (sending a log embed, etc.).
 */
export async function safeSideEffect<T>(
  fn: () => Promise<T>,
  onError: (err: unknown) => void
): Promise<T | undefined> {
  try {
    return await fn();
  } catch (err) {
    onError(err);
    return undefined;
  }
}
