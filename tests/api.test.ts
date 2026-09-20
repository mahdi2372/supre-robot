import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { z } from 'zod';
import { loadConfig } from '../src/config/index.js';
import { MemoryCache } from '../src/cache/memory.js';
import { SettingsService } from '../src/core/settings.js';
import { Metrics } from '../src/core/metrics.js';
import { FakeExecutor, silentLogger } from './helpers/fakes.js';
import { createApiApp, type ApiDeps } from '../src/api/app.js';

const MANAGE_GUILD = (0x20).toString();

const env = {
  DISCORD_TOKEN: 't',
  DISCORD_CLIENT_ID: 'c',
  DISCORD_CLIENT_SECRET: 's',
  DATABASE_URL: 'postgres://u:p@localhost/db',
  SESSION_SECRET: 'x'.repeat(64),
  ADMIN_API_KEY: 'admin-key-123456'
} as NodeJS.ProcessEnv;
const config = loadConfig(env);

const demoSchema = z
  .object({
    count: z.number().int().min(1).max(100).default(10)
  })
  .default({});
const demoDefaults = { count: 10 };

interface GuildStub {
  id: string;
  name: string;
  permissions: string;
  owner: boolean;
  icon: string | null;
}

function makeApp(guilds: GuildStub[] = []) {
  const db = new FakeExecutor();
  db.on(/SELECT 1/, [{ '?column?': 1 }]);
  db.on(/SELECT settings FROM guild_settings/, []);
  db.on(/SELECT enabled FROM guild_settings/, []);
  db.on(/INSERT INTO guild_settings/, []);
  db.on(/INSERT INTO servers/, []);
  db.on(/INSERT INTO bot_logs/, []);

  const token = 'test-session-token';
  db.on(/FROM dashboard_sessions WHERE token_hash/, [
    {
      discord_id: 'u1',
      username: 'tester',
      avatar: null,
      guilds,
      expires_at: new Date(Date.now() + 3600_000)
    }
  ]);

  const settings = new SettingsService(db, new MemoryCache(), silentLogger());
  settings.register('demo', { schema: demoSchema, defaults: demoDefaults });

  const deps: ApiDeps = {
    config,
    logger: silentLogger(),
    db,
    dbPool: db as unknown as ApiDeps['dbPool'],
    cache: new MemoryCache(),
    settings,
    statusSnapshot: () => ({
      bot: {
        status: 'ready',
        version: 'test',
        uptimeMs: 1000,
        latencyMs: 10,
        username: 'bot',
        guildCount: 1
      },
      modules: { core: { status: 'ready', version: '0.1.0' } },
      errors: new Metrics().snapshot(),
      commands: new Metrics().commandsSnapshot()
    }),
    moduleDescriptions: { demo: 'demo module' }
  };
  return { app: createApiApp(deps), db, cookie: `supre_session=${token}` };
}

const g = (id: string, perms = MANAGE_GUILD, owner = false): GuildStub => ({
  id,
  name: `Server ${id}`,
  permissions: perms,
  owner,
  icon: null
});

describe('API — health & errors', () => {
  it('GET /api/v1/health returns ok without auth', async () => {
    const { app } = makeApp();
    const res = await request(app).get('/api/v1/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  it('unknown routes return a JSON 404', async () => {
    const { app } = makeApp();
    const res = await request(app).get('/api/v1/definitely-not-real');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('rejects unauthenticated access to the servers API', async () => {
    // Note: the session middleware consults the DB with no cookie → no session.
    const { app } = makeApp();
    const res = await request(app).get('/api/v1/servers');
    expect(res.status).toBe(401);
  });

  it('status endpoint accepts the admin API key', async () => {
    const { app } = makeApp();
    const res = await request(app).get('/api/v1/status').set('X-Api-Key', 'admin-key-123456');
    expect(res.status).toBe(200);
    expect(res.body.database).toBeDefined();
    expect(res.body.modules.core.status).toBe('ready');
  });

  it('status endpoint rejects a bad API key', async () => {
    const { app } = makeApp();
    const res = await request(app).get('/api/v1/status').set('X-Api-Key', 'wrong');
    expect(res.status).toBe(401);
  });

  it('malformed JSON bodies return 400, not 500', async () => {
    const { app } = makeApp();
    const res = await request(app)
      .post('/api/v1/auth/logout')
      .set('Content-Type', 'application/json')
      .send('{"broken":');
    expect(res.status).toBe(400);
  });
});

describe('API — permission-aware server settings', () => {
  it('allows only guilds from the user’s own session', async () => {
    const { app, cookie } = makeApp([g('g1')]);

    const ok = await request(app).get('/api/v1/servers/g1').set('Cookie', cookie);
    expect(ok.status).toBe(200);
    expect(ok.body.guild.name).toBe('Server g1');
    expect(ok.body.modules.demo.enabled).toBe(true);

    const denied = await request(app).get('/api/v1/servers/g2').set('Cookie', cookie);
    expect(denied.status).toBe(403);
  });

  it('PATCH settings requires ManageGuild (client claims are not trusted)', async () => {
    const { app, cookie } = makeApp([g('g1', '1')]); // member without ManageGuild
    const res = await request(app)
      .patch('/api/v1/servers/g1/modules/demo')
      .set('Cookie', cookie)
      .send({ settings: { count: 5 } });
    expect(res.status).toBe(403);
  });

  it('owners may patch without the explicit permission bit', async () => {
    const { app, cookie } = makeApp([g('g1', '0', true)]);
    const res = await request(app)
      .patch('/api/v1/servers/g1/modules/demo')
      .set('Cookie', cookie)
      .send({ settings: { count: 7 } });
    expect(res.status).toBe(200);
    expect(res.body.settings.count).toBe(7);
  });

  it('PATCH validates against the module schema', async () => {
    const { app, cookie } = makeApp([g('g1')]);

    const bad = await request(app)
      .patch('/api/v1/servers/g1/modules/demo')
      .set('Cookie', cookie)
      .send({ settings: { count: 99999 } });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('INVALID_INPUT');

    const good = await request(app)
      .patch('/api/v1/servers/g1/modules/demo')
      .set('Cookie', cookie)
      .send({ settings: { count: 42 } });
    expect(good.status).toBe(200);
    expect(good.body.settings.count).toBe(42);
  });

  it('PATCH of an unknown module is rejected', async () => {
    const { app, cookie } = makeApp([g('g1')]);
    const res = await request(app)
      .patch('/api/v1/servers/g1/modules/nope')
      .set('Cookie', cookie)
      .send({ settings: {} });
    expect(res.status).toBe(400);
  });

  it('core module cannot be disabled via the API', async () => {
    const { app, cookie } = makeApp([g('g1')]);
    const res = await request(app)
      .patch('/api/v1/servers/g1/modules/core')
      .set('Cookie', cookie)
      .send({ enabled: false });
    expect(res.status).toBe(400);
  });
});

describe('API — dashboard', () => {
  it('redirects unauthenticated visitors to the OAuth login', async () => {
    const { app } = makeApp();
    const res = await request(app).get('/dashboard').redirects(0);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/api/v1/auth/login');
  });

  it('renders the server list with HTML-escaped names (no XSS)', async () => {
    const { app, cookie } = makeApp([{ ...g('g1'), name: '<script>alert(1)</script>' }]);
    const res = await request(app).get('/dashboard').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.text).toContain('&lt;script&gt;');
    expect(res.text).not.toContain('<script>alert(1)</script>');
  });

  it('login endpoint redirects to Discord authorize with the right client id', async () => {
    const { app } = makeApp();
    const res = await request(app).get('/api/v1/auth/login').redirects(0);
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('discord.com/oauth2/authorize');
    expect(res.headers.location).toContain(`client_id=${config.DISCORD_CLIENT_ID}`);
  });
});
