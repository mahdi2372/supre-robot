export interface CacheStore {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown, ttlSeconds?: number): Promise<void>;
  del(key: string): Promise<void>;
  /** Atomic increment; returns the new value. First call initializes at 1. */
  incr(key: string, ttlSeconds?: number): Promise<number>;
  close(): Promise<void>;
}
