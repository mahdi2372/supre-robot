/**
 * Pure transcript building (no Discord dependencies — unit-testable).
 *
 * Output is a list of plain-text chunks, each at most `MAX_CHUNK` characters,
 * safe to post inside a Discord code block (2000-char message limit).
 */
export interface TranscriptMessage {
  /** Pre-formatted author label, e.g. "Alice (123)". */
  author: string;
  content: string;
  at: Date;
}

const MAX_CHUNK = 1900;

/** Split an over-long line into hard chunks of at most `max` characters. */
function splitLine(line: string, max: number): string[] {
  if (line.length <= max) return [line];
  const out: string[] = [];
  for (let i = 0; i < line.length; i += max) {
    out.push(line.slice(i, i + max));
  }
  return out;
}

function formatTime(d: Date): string {
  // "2026-09-20 12:34:56Z" — compact, unambiguous, stable for tests.
  return d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, 'Z');
}

/**
 * Build transcript chunks from the most recent `limit` messages (input order
 * is chronological; the tail is kept).
 */
export function buildTranscriptChunks(messages: TranscriptMessage[], limit: number): string[] {
  const taken = messages.slice(Math.max(0, messages.length - limit));
  const chunks: string[] = [];
  let current: string[] = [];
  let currentLen = 0;

  const push = (line: string): void => {
    for (const piece of splitLine(line, MAX_CHUNK)) {
      const add = piece.length + (current.length > 0 ? 1 : 0);
      if (current.length > 0 && currentLen + add > MAX_CHUNK) {
        chunks.push(current.join('\n'));
        current = [];
        currentLen = 0;
      }
      current.push(piece);
      currentLen += piece.length + (current.length > 1 ? 1 : 0);
    }
  };

  for (const m of taken) {
    push(`[${formatTime(m.at)}] ${m.author}: ${m.content || '*(attachment/other)*'}`);
  }
  if (current.length > 0) chunks.push(current.join('\n'));
  return chunks;
}
