import { Redis } from 'ioredis';
import type { Logger } from '../logging/logger.js';
import type { CacheStore } from './types.js';

/**
 * Redis-backed cache. Values are JSON-serialized; TTL is enforced both by
 * Redis itself (PEXPIRE) and a companion `:exp` key checked on read.
 */
export class RedisCache implements CacheStore {
  private client: Redis;

  constructor(url: string, private readonly logger: Logger, prefix = 'supre') {
    this.client = new Redis(url, {
      lazyConnect: false,
      maxRetriesPerRequest: 2,
      enableOfflineQueue: false,
      keyPrefix: prefix + ':',
      retryStrategy: (times: number) => (times > 20 ? null : Math.min(times * 500, 5000))
    });
    this.client.on('error', (err) => {
      this.logger.warn({ err: { message: err.message } }, 'redis connection error');
    });
  }

  async ping(): Promise<void> {
    await this.client.ping();
  }

  private async isExpired(key: string): Promise<boolean> {
    const exp = await this.client.get(`${key}:exp`);
    return exp !== null && Number(exp) <= Date.now();
  }

  async get<T>(key: string): Promise<T | undefined> {
    try {
      if (await this.isExpired(key)) {
        await this.client.del(key, `${key}:exp`);
        return undefined;
      }
      const raw = await this.client.get(key);
      if (raw === null) return undefined;
      return JSON.parse(raw) as T;
    } catch (err) {
      this.logger.debug({ err: { message: (err as Error).message } }, 'cache get failed');
      return undefined;
    }
  }

  async set(key: string, value: unknown, ttlSeconds?: number): Promise<void> {
    const raw = JSON.stringify(value);
    if (ttlSeconds && ttlSeconds > 0) {
      const p = this.client.multi();
      p.set(key, raw);
      p.set(`${key}:exp`, String(Date.now() + ttlSeconds * 1000));
      p.pexpire(key, ttlSeconds * 1000);
      p.pexpire(`${key}:exp`, ttlSeconds * 1000);
      await p.exec();
    } else {
      await this.client.set(key, raw);
    }
  }

  async del(key: string): Promise<void> {
    await this.client.del(key, `${key}:exp`);
  }

  async incr(key: string, ttlSeconds?: number): Promise<number> {
    try {
      const val = await this.client.incr(key);
      if (ttlSeconds && val === 1) await this.client.pexpire(key, ttlSeconds * 1000);
      return val;
    } catch (err) {
      this.logger.warn({ err: { message: (err as Error).message } }, 'redis incr failed');
      throw err;
    }
  }

  async close(): Promise<void> {
    await this.client.quit().catch(() => this.client.disconnect());
  }
}
