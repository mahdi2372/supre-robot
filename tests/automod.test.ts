import { describe, expect, it } from 'vitest';
import {
  detectBannedWords,
  detectCaps,
  detectCustomRegex,
  detectEmoji,
  detectInvite,
  detectMentions,
  detectNewAccount,
  detectSuspiciousUrl,
  duplicateSignal,
  floodSignal,
  normalizeForMatching,
  type DetectorSignal,
  type MessageLike
} from '../src/modules/automod/detectors.js';
import { decide, hashContent, MessageTracker } from '../src/modules/automod/engine.js';
import { automodSettingsDefaults as d } from '../src/modules/automod/settings.js';

const fresh = (): MessageLike => ({
  content: '',
  mentionUserIds: [],
  mentionEveryone: false,
  authorId: 'u1',
  authorCreatedAt: new Date()
});

describe('caps detector', () => {
  it('ignores short messages', () => {
    expect(detectCaps('HELPME', d.caps)).toBeNull();
  });
  it('flags all-caps above threshold', () => {
    const sig = detectCaps('THIS IS A VERY LOUD MESSAGE IN CAPS', d.caps);
    expect(sig).not.toBeNull();
    expect(sig!.type).toBe('caps');
    expect(sig!.score).toBeGreaterThanOrEqual(0.5);
  });
  it('passes normal text', () => {
    expect(detectCaps('this is a normal message with caps', d.caps)).toBeNull();
  });
});

describe('emoji detector', () => {
  it('flags emoji-heavy messages', () => {
    const sig = detectEmoji('🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥', d.emoji);
    expect(sig).not.toBeNull();
    expect(sig!.type).toBe('emoji');
  });
  it('ignores a few emoji in text', () => {
    expect(detectEmoji('nice post, good luck 🍀', d.emoji)).toBeNull();
  });
});

describe('mentions detector', () => {
  it('flags mention spam', () => {
    const m = fresh();
    m.mentionUserIds = Array.from({ length: 7 }, (_, i) => String(1000 + i));
    const sig = detectMentions(m, d.mentions);
    expect(sig).not.toBeNull();
  });
  it('flags @everyone extra hard', () => {
    const m = fresh();
    m.mentionUserIds = Array.from({ length: d.mentions.threshold }, () => '1');
    m.mentionEveryone = true;
    const sig = detectMentions(m, d.mentions)!;
    expect(sig.score).toBeGreaterThan(0.7);
  });
});

describe('invite detector', () => {
  it('detects discord.gg links', () => {
    expect(detectInvite('join discord.gg/someinvite', d.invite)).not.toBeNull();
  });
  it('detects discord.com/invite links', () => {
    expect(detectInvite('https://discord.com/invite/abc123', d.invite)).not.toBeNull();
  });
  it('ignores normal urls', () => {
    expect(detectInvite('see https://example.com/docs', d.invite)).toBeNull();
  });
});

describe('suspicious url detector', () => {
  it('flags shortener domains', () => {
    expect(detectSuspiciousUrl('go here https://bit.ly/abc', d.suspiciousUrl)).not.toBeNull();
  });
  it('flags subdomains of listed domains', () => {
    expect(detectSuspiciousUrl('https://x.tinyurl.com/abc', d.suspiciousUrl)).not.toBeNull();
  });
  it('ignores legitimate links', () => {
    expect(detectSuspiciousUrl('https://github.com/foo/bar', d.suspiciousUrl)).toBeNull();
  });
});

describe('banned words', () => {
  it('matches whole words case-insensitively', () => {
    const cfg = { enabled: true, words: ['badword'] };
    expect(detectBannedWords('this is a BADWORD test', cfg)).not.toBeNull();
    expect(detectBannedWords('unrelated text', cfg)).toBeNull();
    // 'badwordz' should not match the whole-word rule
    expect(detectBannedWords('contains badwordz inside', cfg)).toBeNull();
  });
  it('defeats zero-width evasion', () => {
    const cfg = { enabled: true, words: ['badword'] };
    expect(detectBannedWords('ba​dword', cfg)).not.toBeNull();
  });
  it('short banned words score lower', () => {
    const cfg = { enabled: true, words: ['no'] };
    const sig = detectBannedWords('the no one knew', cfg)!;
    expect(sig.score).toBeLessThan(0.6);
  });
});

describe('custom regex', () => {
  it('matches admin patterns', () => {
    const cfg = { enabled: true, patterns: ['\\b(bad\\d+)\\b'] };
    expect(detectCustomRegex('hello bad123 world', cfg)).not.toBeNull();
  });
  it('tolerates invalid regex (no crash)', () => {
    const cfg = { enabled: true, patterns: ['[invalid'] };
    expect(detectCustomRegex('anything', cfg)).toBeNull();
  });
});

describe('new account (weak signal)', () => {
  it('flags fresh accounts', () => {
    const m = fresh();
    m.authorCreatedAt = new Date(Date.now() - 5 * 60_000);
    const sig = detectNewAccount(m, d.newAccount);
    expect(sig).not.toBeNull();
    expect(sig!.weak).toBe(true);
  });
  it('ignores older accounts', () => {
    const m = fresh();
    m.authorCreatedAt = new Date(Date.now() - 3 * 3600_000);
    expect(detectNewAccount(m, d.newAccount)).toBeNull();
  });
});

describe('stateful signals', () => {
  it('flood fires past the window limit', () => {
    expect(floodSignal(3, d.flood)).toBeNull();
    expect(floodSignal(d.flood.maxMessages, d.flood)).not.toBeNull();
  });
  it('duplicate fires past its limit', () => {
    expect(duplicateSignal(2, d.duplicate)).toBeNull();
    expect(duplicateSignal(d.duplicate.maxDuplicates, d.duplicate)).not.toBeNull();
  });
});

describe('normalizeForMatching', () => {
  it('lowercases and strips separators', () => {
    expect(normalizeForMatching('  A-B * C ')).toBe('a b c');
  });
});

describe('decide() — the false-positive protection policy', () => {
  const sig = (score: number, weak = false): DetectorSignal => ({ type: 'caps', score, detail: '', weak });

  it('allows when nothing is detected', () => {
    expect(decide([], d).verdict).toBe('allow');
  });

  it('NEVER punishes on weak signals alone (new account, etc.)', () => {
    const weak = sig(0.99, true);
    const decision = decide([weak], d);
    expect(decision.verdict).toBe('allow');
  });

  it('deletes at/above the delete threshold', () => {
    expect(decide([sig(0.6)], d).verdict).toBe('delete');
  });

  it('acts at/above the action threshold', () => {
    expect(decide([sig(0.85)], d).verdict).toBe('action');
  });

  it('allows below the delete threshold', () => {
    expect(decide([sig(0.4)], d).verdict).toBe('allow');
  });

  it('two moderate signals combine to cross the action threshold via boost', () => {
    // 0.7 + 0.15 boost = 0.85 >= 0.85 action threshold
    expect(decide([sig(0.7), sig(0.55)], d).verdict).toBe('action');
  });

  it('a weak + strong pair still only counts the strong one (plus boost when >=2 strong)', () => {
    expect(decide([sig(0.5, true), sig(0.6)], d).verdict).toBe('delete');
  });
});

describe('MessageTracker', () => {
  it('counts messages within the window only', () => {
    const t = new MessageTracker();
    const now = Date.now();
    expect(t.floodCount('g:u', now - 9000, 10_000)).toBe(1);
    expect(t.floodCount('g:u', now - 5000, 10_000)).toBe(2);
    // message 15s ago is outside a 10s window
    expect(t.floodCount('g:u', now + 5000, 10_000)).toBe(1);
  });

  it('tracks duplicate content per user separately', () => {
    const t = new MessageTracker();
    const now = Date.now();
    const h1 = hashContent('spam spam');
    const h2 = hashContent('different');
    expect(t.duplicateCount('a', h1, now, 60_000)).toBe(1);
    expect(t.duplicateCount('b', h1, now, 60_000)).toBe(1);
    expect(t.duplicateCount('a', h2, now, 60_000)).toBe(1);
    expect(t.duplicateCount('a', h1, now + 1000, 60_000)).toBe(2);
  });

  it('hashContent is stable', () => {
    expect(hashContent('x')).toBe(hashContent('x'));
    expect(hashContent('x')).not.toBe(hashContent('y'));
  });
});
