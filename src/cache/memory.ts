import type { CacheStore } from './types.js';

interface Entry {
  value: unknown;
  expiresAt: number | null;
}

/**
 * Bounded in-memory cache with TTL. Used when Redis is not configured and as
 * a test double. Evicts expired entries lazily and drops the oldest-inserted
 * entry when over capacity.
 */
export class MemoryCache implements CacheStore {
  private entries = new Map<string, Entry>();
  constructor(private readonly capacity = 10_000) {}

  async get<T>(key: string): Promise<T | undefined> {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value as T;
  }

  async set(key: string, value: unknown, ttlSeconds?: number): Promise<void> {
    if (this.entries.has(key)) this.entries.delete(key); // refresh insertion order
    else if (this.entries.size >= this.capacity) {
      const oldest = this.entries.keys().next();
      if (!oldest.done) this.entries.delete(oldest.value);
    }
    this.entries.set(key, { value, expiresAt: ttlSeconds ? Date.now() + ttlSeconds * 1000 : null });
  }

  async del(key: string): Promise<void> {
    this.entries.delete(key);
  }

  async incr(key: string, ttlSeconds?: number): Promise<number> {
    const current = await this.get<number>(key);
    const next = (current ?? 0) + 1;
    await this.set(key, next, ttlSeconds);
    return next;
  }

  async close(): Promise<void> {
    this.entries.clear();
  }
}
