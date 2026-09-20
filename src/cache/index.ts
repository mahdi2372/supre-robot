import type { Logger } from '../logging/logger.js';
import type { AppConfig } from '../config/index.js';
import type { CacheStore } from './types.js';
import { MemoryCache } from './memory.js';

export type { CacheStore } from './types.js';
export { MemoryCache } from './memory.js';
export { RedisCache } from './redis.js';

/**
 * Cache factory: Redis when REDIS_URL is configured, otherwise a bounded
 * in-memory cache. The rest of the codebase only ever sees `CacheStore`.
 */
export async function createCache(
  config: AppConfig,
  logger: Logger
): Promise<{ store: CacheStore; kind: 'memory' | 'redis' }> {
  if (!config.REDIS_URL) {
    logger.warn('REDIS_URL not set — using in-memory cache (single instance only)');
    return { store: new MemoryCache(), kind: 'memory' };
  }
  try {
    const { RedisCache } = await import('./redis.js');
    const store = new RedisCache(config.REDIS_URL, logger);
    await store.ping();
    logger.info({ url: redactUrl(config.REDIS_URL) }, 'connected to Redis cache');
    return { store, kind: 'redis' };
  } catch (err) {
    logger.error({ err }, 'Redis unavailable — falling back to in-memory cache');
    return { store: new MemoryCache(), kind: 'memory' };
  }
}

function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) u.password = '[REDACTED]';
    return u.toString();
  } catch {
    return '[invalid-url]';
  }
}
