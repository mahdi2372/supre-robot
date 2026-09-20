import { createHash } from 'node:crypto';
import type { AutoModSettings } from './settings.js';
import type { DetectorSignal } from './detectors.js';

export interface Decision {
  verdict: 'allow' | 'delete' | 'action';
  confidence: number;
  signals: DetectorSignal[];
}

const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));

/**
 * Decision policy (false-positive protection, per spec):
 *  - weak signals (e.g. "new account") can NEVER drive an action alone;
 *  - confidence = max strong-signal score, +multiSignalBoost when two or
 *    more independent strong signals agree (capped at 1);
 *  - confidence >= actionThreshold -> punishment action;
 *  - confidence >= deleteThreshold -> delete only;
 *  - otherwise -> allow (signals are still logged for review).
 */
export function decide(signals: DetectorSignal[], cfg: Pick<AutoModSettings, 'deleteThreshold' | 'actionThreshold' | 'multiSignalBoost'>): Decision {
  if (signals.length === 0) return { verdict: 'allow', confidence: 0, signals };

  const strong = signals.filter((s) => !s.weak);
  const peakWeak = Math.max(...signals.map((s) => s.score));
  if (strong.length === 0) {
    return { verdict: 'allow', confidence: peakWeak, signals };
  }

  const peak = Math.max(...strong.map((s) => s.score));
  const confidence = strong.length >= 2 ? clamp01(peak + cfg.multiSignalBoost) : peak;

  if (confidence >= cfg.actionThreshold) return { verdict: 'action', confidence, signals };
  if (confidence >= cfg.deleteThreshold) return { verdict: 'delete', confidence, signals };
  return { verdict: 'allow', confidence, signals };
}

export function hashContent(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 32);
}

/**
 * In-memory sliding windows for stateful detectors (flood, duplicate).
 * Per-guild, per-user. Windows are pruned lazily; entries for idle users are
 * swept periodically. Memory is bounded: at most one window per active user.
 */
export class MessageTracker {
  private flood = new Map<string, number[]>();
  private duplicate = new Map<string, Map<string, number[]>>();
  private lastActivity = new Map<string, number>();

  private sweep(now: number): void {
    const STALE_MS = 10 * 60 * 1000;
    for (const [key, last] of this.lastActivity) {
      if (now - last > STALE_MS) {
        this.flood.delete(key);
        this.duplicate.delete(key);
        this.lastActivity.delete(key);
      }
    }
  }

  /**
   * Returns the count of messages this user sent within windowMs.
   * The window is (now - windowMs, now] — a message exactly windowMs old is
   * already expired.
   */
  floodCount(key: string, now: number, windowMs: number): number {
    this.sweep(now);
    const arr = this.flood.get(key) ?? [];
    arr.push(now);
    const cutoff = now - windowMs;
    const pruned = arr.filter((t) => t > cutoff);
    this.flood.set(key, pruned);
    this.lastActivity.set(key, now);
    return pruned.length;
  }

  /**
   * Returns the count of identical messages within windowMs.
   * The window is (now - windowMs, now] — a message exactly windowMs old is
   * already expired.
   */
  duplicateCount(key: string, contentHash: string, now: number, windowMs: number): number {
    this.sweep(now);
    const map = this.duplicate.get(key) ?? new Map<string, number[]>();
    const arr = map.get(contentHash) ?? [];
    arr.push(now);
    const cutoff = now - windowMs;
    const pruned = arr.filter((t) => t > cutoff);
    map.set(contentHash, pruned);
    this.duplicate.set(key, map);
    this.lastActivity.set(key, now);
    return pruned.length;
  }

  get trackedUsers(): number {
    return this.lastActivity.size;
  }
}
