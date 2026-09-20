import type { AutoModSettings } from './settings.js';

/**
 * Pure, stateless AutoMod detectors.
 *
 * Each detector returns zero or one signal with a confidence score in
 * [0, 1]. Scoring model: a value exactly at threshold scores 0.5, double
 * the threshold scores 1.0 (`score(value) = clamp((value - t) / t + 0.5)`).
 * Stateful detectors (flood, duplicate) are handled by the engine, which
 * keeps per-user windows in memory and calls `floodSignal`/`duplicateSignal`
 * with the observed counts.
 */

export interface DetectorSignal {
  type:
    | 'caps'
    | 'emoji'
    | 'mentions'
    | 'invite'
    | 'suspicious_url'
    | 'banned_word'
    | 'custom_regex'
    | 'new_account'
    | 'flood'
    | 'duplicate';
  /** Confidence 0..1 */
  score: number;
  detail: string;
  /** Weak signals can never, alone, cross the action threshold. */
  weak?: boolean;
}

export interface MessageLike {
  content: string;
  mentionUserIds: string[];
  mentionEveryone: boolean;
  authorId: string;
  authorCreatedAt: Date;
}

const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));
const scoreAt = (value: number, threshold: number): number => clamp01((value - threshold) / threshold + 0.5);

/** Strip zero-width / homoglyph-adjacent noise for banned-word matching. */
export function normalizeForMatching(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, '')
    .replace(/[-_.*\s]+/g, ' ')
    .trim();
}

export function detectCaps(content: string, cfg: AutoModSettings['caps']): DetectorSignal | null {
  if (!cfg.enabled) return null;
  const letters = content.replace(/[^a-zA-Z]/g, '');
  if (letters.length < cfg.minLength) return null;
  const upper = content.replace(/[^A-Z]/g, '').length;
  const ratio = upper / letters.length;
  if (ratio < cfg.ratio) return null;
  return {
    type: 'caps',
    score: scoreAt(ratio, cfg.ratio),
    detail: `uppercase ratio ${ratio.toFixed(2)} (threshold ${cfg.ratio})`
  };
}

const EMOJI_RE =
  /[\u{1F1E6}-\u{1F1FF}\u{1F300}-\u{1F5FF}\u{1F600}-\u{1F64F}\u{1F680}-\u{1F6FF}\u{1F700}-\u{1F77F}\u{1F780}-\u{1F7FF}\u{1F800}-\u{1F8FF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}]/gu;
const CUSTOM_EMOJI_RE = /<a?:\w{2,32}:\d{10,20}>/g;

export function detectEmoji(content: string, cfg: AutoModSettings['emoji']): DetectorSignal | null {
  if (!cfg.enabled) return null;
  const emojiCount = (content.match(EMOJI_RE) ?? []).length + (content.match(CUSTOM_EMOJI_RE) ?? []).length;
  if (emojiCount < 3) return null;
  const ratio = emojiCount / Math.max(1, content.length / 4);
  if (ratio < cfg.ratio) return null;
  return {
    type: 'emoji',
    score: scoreAt(ratio, cfg.ratio),
    detail: `${emojiCount} emojis (ratio ${ratio.toFixed(2)} vs ${cfg.ratio})`
  };
}

export function detectMentions(msg: MessageLike, cfg: AutoModSettings['mentions']): DetectorSignal | null {
  if (!cfg.enabled) return null;
  const count = msg.mentionUserIds.length + (msg.mentionEveryone ? 10 : 0);
  if (count < cfg.threshold) return null;
  const signal: DetectorSignal = {
    type: 'mentions',
    score: scoreAt(count, cfg.threshold),
    detail: `${count} mentions (threshold ${cfg.threshold})`
  };
  if (msg.mentionEveryone) signal.score = clamp01(signal.score + 0.2);
  return signal;
}

const INVITE_RE = /(discord\.gg\/[a-zA-Z0-9]+|discord(?:app)?\.com\/invite\/[a-zA-Z0-9]+|discord\.me\/[a-zA-Z0-9]+|discord(?:app)?\.com\/partners)/i;

export function detectInvite(content: string, cfg: AutoModSettings['invite']): DetectorSignal | null {
  if (!cfg.enabled) return null;
  const match = content.match(INVITE_RE);
  if (!match) return null;
  return { type: 'invite', score: 0.9, detail: `invite link: ${match[0].slice(0, 60)}` };
}

export function detectSuspiciousUrl(content: string, cfg: AutoModSettings['suspiciousUrl']): DetectorSignal | null {
  if (!cfg.enabled || cfg.domains.length === 0) return null;
  const urls = content.match(/https?:\/\/[^\s<>"')\]]+/gi) ?? [];
  for (const url of urls) {
    try {
      const host = new URL(url).hostname.toLowerCase();
      const hit = cfg.domains.find((d) => host === d.toLowerCase() || host.endsWith(`.${d.toLowerCase()}`));
      if (hit) {
        return { type: 'suspicious_url', score: 0.7, detail: `shortened/suspicious domain: ${hit}` };
      }
    } catch {
      // unparseable URL token — ignore
    }
  }
  return null;
}

export function detectBannedWords(content: string, cfg: AutoModSettings['bannedWords']): DetectorSignal | null {
  if (!cfg.enabled || cfg.words.length === 0) return null;
  const normalized = normalizeForMatching(content);
  for (const word of cfg.words) {
    const w = normalizeForMatching(word);
    if (!w) continue;
    // Word-boundary-ish match: allow it at the start, end, or next to non-letters.
    const re = new RegExp(`(?<![a-z0-9])${escapeRegExp(w)}(?![a-z0-9])`);
    if (re.test(normalized)) {
      // Short banned words are easier to false-positive; lower their score.
      return {
        type: 'banned_word',
        score: w.length < 4 ? 0.5 : 0.75,
        detail: `banned word match (${word.length < 4 ? 'short word, reduced confidence' : ''})`
      };
    }
  }
  return null;
}

const compiledPatterns = new Map<string, RegExp | null>();

export function detectCustomRegex(content: string, cfg: AutoModSettings['customRegex']): DetectorSignal | null {
  if (!cfg.enabled || cfg.patterns.length === 0) return null;
  for (const pattern of cfg.patterns) {
    let re = compiledPatterns.get(pattern);
    if (re === undefined) {
      try {
        re = new RegExp(pattern, 'i');
      } catch {
        re = null;
      }
      compiledPatterns.set(pattern, re);
    }
    if (re && re.test(content)) {
      return { type: 'custom_regex', score: 0.7, detail: `custom regex matched: ${pattern.slice(0, 60)}` };
    }
  }
  return null;
}

export function detectNewAccount(msg: MessageLike, cfg: AutoModSettings['newAccount']): DetectorSignal | null {
  if (!cfg.enabled) return null;
  const ageMin = (Date.now() - msg.authorCreatedAt.getTime()) / 60_000;
  if (ageMin >= cfg.minAccountAgeMinutes) return null;
  return {
    type: 'new_account',
    score: 0.3,
    weak: true,
    detail: `account age ${Math.max(0, Math.floor(ageMin))}min (< ${cfg.minAccountAgeMinutes}min)`
  };
}

export function floodSignal(observedCount: number, cfg: AutoModSettings['flood']): DetectorSignal | null {
  if (!cfg.enabled) return null;
  if (observedCount < cfg.maxMessages) return null;
  return {
    type: 'flood',
    score: scoreAt(observedCount, cfg.maxMessages),
    detail: `${observedCount} messages in window (limit ${cfg.maxMessages})`
  };
}

export function duplicateSignal(observedCount: number, cfg: AutoModSettings['duplicate']): DetectorSignal | null {
  if (!cfg.enabled) return null;
  if (observedCount < cfg.maxDuplicates) return null;
  return {
    type: 'duplicate',
    score: scoreAt(observedCount, cfg.maxDuplicates),
    detail: `${observedCount} identical messages in window (limit ${cfg.maxDuplicates})`
  };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
