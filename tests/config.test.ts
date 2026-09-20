import { describe, expect, it } from 'vitest';
import { loadConfig, ConfigError } from '../src/config/index.js';

const base = {
  DISCORD_TOKEN: 'test-token',
  DISCORD_CLIENT_ID: '123',
  DISCORD_CLIENT_SECRET: 'secret',
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  SESSION_SECRET: 'a'.repeat(64)
};

describe('loadConfig', () => {
  it('loads a valid environment with defaults applied', () => {
    const config = loadConfig({ ...base } as NodeJS.ProcessEnv);
    expect(config.NODE_ENV).toBe('development');
    expect(config.API_PORT).toBe(3000);
    expect(config.LOG_RETENTION_DAYS).toBe(30);
    expect(config.DATABASE_AUTO_MIGRATE).toBe(true);
    expect(config.REDIS_URL).toBeUndefined();
  });

  it('rejects a missing bot token with a clear message', () => {
    const env = { ...base } as NodeJS.ProcessEnv;
    delete env.DISCORD_TOKEN;
    expect(() => loadConfig(env)).toThrowError(ConfigError);
    expect(() => loadConfig(env)).toThrow(/DISCORD_TOKEN/);
  });

  it('rejects a short session secret', () => {
    expect(() => loadConfig({ ...base, SESSION_SECRET: 'short' } as NodeJS.ProcessEnv)).toThrow(/SESSION_SECRET/);
  });

  it('rejects an invalid public url', () => {
    expect(() => loadConfig({ ...base, PUBLIC_BASE_URL: 'not-a-url' } as NodeJS.ProcessEnv)).toThrow(/PUBLIC_BASE_URL/);
  });

  it('coerces numeric env values', () => {
    const config = loadConfig({ ...base, API_PORT: '8080', REQUEST_RATE_LIMIT_PER_MINUTE: '50' } as NodeJS.ProcessEnv);
    expect(config.API_PORT).toBe(8080);
    expect(config.REQUEST_RATE_LIMIT_PER_MINUTE).toBe(50);
  });

  it('rejects a bad DISCORD_GUILD_ID format', () => {
    expect(() => loadConfig({ ...base, DISCORD_GUILD_ID: 'abc' } as NodeJS.ProcessEnv)).toThrow(/DISCORD_GUILD_ID/);
  });
});
