import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createApp } from '../server/app.js';
import { loadConfig } from '../server/config.js';
import { openDatabase } from '../server/db.js';
import { createStore } from '../server/store.js';
import { createLogger } from '../server/logger.js';

const silentLogger = createLogger('error', { log() {}, warn() {}, error() {} });

function startServer() {
  const dir = mkdtempSync(path.join(tmpdir(), 'instava-api-'));
  const config = loadConfig({
    DATA_DIR: dir,
    DATABASE_FILE: path.join(dir, 'test.sqlite'),
    PUBLIC_DIR: path.join(process.cwd(), 'public'),
    INSTAVA_SECRET_KEY: 'cle-de-test-uniquement-pour-les-tests',
    INSTAVA_TZ: 'Africa/Porto-Novo',
    INSTAVA_LOG_LEVEL: 'error',
    PORT: '0',
  });
  const db = openDatabase(config.databaseFile);
  const store = createStore(db);
  const { server, worker } = createApp({ config, store, logger: silentLogger, startWorker: false });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        config, db, store, worker, server,
        base: `http://127.0.0.1:${port}`,
        close: () => new Promise((done) => { server.close(() => { db.close(); rmSync(dir, { recursive: true, force: true }); done(); }); }),
      });
    });
  });
}

async function call(ctx, method, pathname, body, cookie) {
  const response = await fetch(`${ctx.base}${pathname}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  const setCookie = response.headers.getSetCookie?.() || [];
  const sessionCookie = setCookie.find((item) => item.startsWith('instava_session='));
  return { status: response.status, data, headers: response.headers, cookie: sessionCookie ? sessionCookie.split(';')[0] : null };
}

test('inscription : le premier compte devient propriétaire et ouvre une session', async () => {
  const ctx = await startServer();
  try {
    const health = await call(ctx, 'GET', '/api/health');
    assert.equal(health.status, 200);
    assert.equal(health.data.firstRun, true);
    assert.equal(health.data.timeZone, 'Africa/Porto-Novo');

    const denied = await call(ctx, 'GET', '/api/targets');
    assert.equal(denied.status, 401);

    const created = await call(ctx, 'POST', '/api/auth/register', { email: 'proprietaire@exemple.test', password: 'motdepasse-solide' });
    assert.equal(created.status, 201);
    assert.equal(created.data.user.role, 'owner');
    assert.ok(created.cookie, 'cookie de session posé');

    const me = await call(ctx, 'GET', '/api/auth/me', null, created.cookie);
    assert.equal(me.status, 200);
    assert.equal(me.data.user.email, 'proprietaire@exemple.test');

    const badLogin = await call(ctx, 'POST', '/api/auth/login', { email: 'proprietaire@exemple.test', password: 'mauvais-mot-de-passe' });
    assert.equal(badLogin.status, 401);
  } finally { await ctx.close(); }
});

test('cible : la durée en jours relève le total au minimum de 100 clics par jour', async () => {
  const ctx = await startServer();
  try {
    const { cookie } = await call(ctx, 'POST', '/api/auth/register', { email: 'a@exemple.test', password: 'motdepasse-solide' });
    const created = await call(ctx, 'POST', '/api/targets', {
      pseudo: 'Boutique', url: 'https://exemple.fr/offre', linkLabel: 'Découvrir', mode: 'interval',
      executionTarget: 50, durationDays: 3,
    }, cookie);
    assert.equal(created.status, 201);
    assert.equal(created.data.target.duration_days, 3);
    assert.equal(created.data.target.effective_total, 300);
    assert.equal(created.data.target.daily_minimum, 100);
    assert.match(created.data.target.description, /300 clics/);

    const invalidDuration = await call(ctx, 'POST', '/api/targets', {
      pseudo: 'X', url: 'https://exemple.fr', mode: 'interval', executionTarget: 100, durationDays: 366,
    }, cookie);
    assert.equal(invalidDuration.status, 400);

    const localUrl = await call(ctx, 'POST', '/api/targets', {
      pseudo: 'X', url: 'http://localhost:8080', mode: 'goal', executionTarget: 10,
    }, cookie);
    assert.equal(localUrl.status, 400);
  } finally { await ctx.close(); }
});

test('lancement : calendrier de visites avec 288 clics maximum par jour', async () => {
  const ctx = await startServer();
  try {
    const { cookie } = await call(ctx, 'POST', '/api/auth/register', { email: 'b@exemple.test', password: 'motdepasse-solide' });
    const target = await call(ctx, 'POST', '/api/targets', {
      pseudo: 'Flux', url: 'https://exemple.fr', linkLabel: '', mode: 'interval',
      executionTarget: 300, durationDays: 1,
    }, cookie);
    assert.equal(target.status, 201);
    assert.equal(target.data.target.effective_total, 288);

    const started = await call(ctx, 'POST', '/api/start', { targetIds: [target.data.target.id], confirmClicks: false }, cookie);
    assert.equal(started.status, 201);
    assert.equal(started.data.plannedVisits, 288);
    assert.equal(started.data.targets[0].visits, 288);

    const visits = ctx.store.listVisits(ctx.store.listUsers()[0].id, { limit: 500 });
    const byDay = new Map();
    for (const visit of visits) {
      const day = visit.scheduled_at.slice(0, 10);
      byDay.set(day, (byDay.get(day) || 0) + 1);
    }
    assert.ok([...byDay.values()].every((count) => count <= 288), `répartition ${JSON.stringify([...byDay])}`);
    // Chaque journée respecte un écart minimal de 5 minutes entre deux visites.
    const sorted = visits.map((visit) => Date.parse(visit.scheduled_at)).sort((a, b) => a - b);
    for (let index = 1; index < sorted.length; index += 1) {
      assert.ok(sorted[index] - sorted[index - 1] >= 5 * 60 * 1000 - 1000, 'écart de 5 minutes respecté');
    }

    const busy = await call(ctx, 'POST', '/api/start', { targetIds: [target.data.target.id] }, cookie);
    assert.equal(busy.status, 409);

    const stopped = await call(ctx, 'POST', '/api/stop', { runId: started.data.run.id }, cookie);
    assert.equal(stopped.status, 200);
    assert.equal(stopped.data.cancelled, 288);
  } finally { await ctx.close(); }
});

test('proxy : les identifiants sont chiffrés et jamais renvoyés en clair', async () => {
  const ctx = await startServer();
  try {
    const { cookie } = await call(ctx, 'POST', '/api/auth/register', { email: 'c@exemple.test', password: 'motdepasse-solide' });
    const saved = await call(ctx, 'POST', '/api/proxy', {
      scheme: 'http', host: 'proxy.exemple.fr', port: 8000,
      username: 'identifiantfictif', password: 'motdepassefictif',
    }, cookie);
    assert.equal(saved.status, 200);

    const row = ctx.store.getProxySettings(ctx.store.listUsers()[0].id);
    assert.ok(!row.secret_box.includes('motdepassefictif'), 'aucun secret en clair dans la base');
    assert.match(row.secret_box, /^v1\./);

    const status = await call(ctx, 'GET', '/api/proxy', null, cookie);
    assert.equal(status.status, 200);
    assert.equal(status.data.configured, true);
    assert.ok(!JSON.stringify(status.data).includes('motdepassefictif'));
    assert.ok(!JSON.stringify(status.data).includes('identifiantfictif'));

    const removed = await call(ctx, 'DELETE', '/api/proxy', null, cookie);
    assert.equal(removed.status, 200);
  } finally { await ctx.close(); }
});

test('sécurité : méthodes inconnues, chemins inconnus et traversée de répertoire', async () => {
  const ctx = await startServer();
  try {
    const { cookie } = await call(ctx, 'POST', '/api/auth/register', { email: 'd@exemple.test', password: 'motdepasse-solide' });
    assert.equal((await call(ctx, 'GET', '/api/unknown')).status, 404);
    assert.equal((await call(ctx, 'PUT', '/api/targets', {}, cookie)).status, 405);

    // Chemins encodés : c'est ce qu'un client malveillant envoie réellement.
    for (const probe of ['/%2e%2e/server/config.js', '/..%2fserver/config.js', '/%2e%2e%2fserver%2fconfig.js']) {
      const response = await fetch(`${ctx.base}${probe}`);
      assert.ok([400, 403, 404].includes(response.status), `${probe} → ${response.status}`);
      const body = await response.text();
      assert.ok(!body.includes('SUPABASE_SERVICE_ROLE_KEY'), 'aucun fichier serveur exposé');
    }

    const index = await fetch(`${ctx.base}/`);
    assert.equal(index.status, 200);
    assert.match(index.headers.get('content-security-policy') || '', /default-src 'self'/);
    assert.equal(index.headers.get('x-frame-options'), 'DENY');
  } finally { await ctx.close(); }
});
