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
  const { server, worker } = createApp({
    config, store, logger: silentLogger, startWorker: false,
    // Limites larges : les tests créent plusieurs comptes depuis la même IP.
    limits: { login: { windowMs: 60_000, max: 1000 }, signup: { windowMs: 60_000, max: 1000 } },
  });
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

test('proxys : import en masse, déduplication, chiffrement et rotation', async () => {
  const ctx = await startServer();
  try {
    const { cookie } = await call(ctx, 'POST', '/api/auth/register', { email: 'c@exemple.test', password: 'motdepasse-solide' });
    const text = [
      'proxy1.exemple.fr:8000:identifiantfictif:motdepassefictif',
      'proxy2.exemple.fr:8001:identifiantfictif:motdepassefictif',
      'identifiantfictif:motdepassefictif@proxy3.exemple.fr:8002',
      'proxy1.exemple.fr:8000:identifiantfictif:motdepassefictif',
      'ligne-invalide',
    ].join('\n');
    const imported = await call(ctx, 'POST', '/api/proxies', { text }, cookie);
    assert.equal(imported.status, 201);
    assert.equal(imported.data.added, 3, 'trois proxys uniques');
    assert.ok(imported.data.duplicates >= 1, 'doublon signalé');
    assert.ok(imported.data.rejected >= 1, 'ligne invalide rejetée');
    // Le premier import active la rotation.
    assert.equal(imported.data.state.enabled, true);

    const listed = await call(ctx, 'GET', '/api/proxies', null, cookie);
    assert.equal(listed.status, 200);
    assert.equal(listed.data.proxies.length, 3);
    assert.equal(listed.data.state.rotation, 'order');
    // Aucun secret en clair dans la réponse.
    const payload = JSON.stringify(listed.data);
    assert.ok(!payload.includes('motdepassefictif'));
    assert.ok(!payload.includes('identifiantfictif'));

    // La base ne contient que des secrets chiffrés.
    const rows = ctx.store.raw.prepare('SELECT * FROM proxies').all();
    assert.equal(rows.length, 3);
    for (const row of rows) {
      assert.ok(!row.secret_box.includes('motdepassefictif'), 'chiffré en base');
      assert.match(row.secret_box, /^v1\./);
    }

    // Rotation : ordre puis retour au début.
    const order = [0, 1, 2, 3].map(() => {
      const picked = ctx.store.listProxies(ctx.store.listUsers()[0].id);
      const state = ctx.store.getProxyState(ctx.store.listUsers()[0].id);
      const index = state.cursor % picked.length;
      ctx.store.saveProxyState(ctx.store.listUsers()[0].id, { cursor: (index + 1) % picked.length });
      return picked[index].host;
    });
    assert.deepEqual(order, ['proxy1.exemple.fr', 'proxy2.exemple.fr', 'proxy3.exemple.fr', 'proxy1.exemple.fr']);

    // Désactivation d'un proxy.
    const first = listed.data.proxies[0];
    const patched = await call(ctx, 'PATCH', '/api/proxies', { id: first.id, enabled: false }, cookie);
    assert.equal(patched.status, 200);
    assert.equal(patched.data.proxy.enabled, false);

    // Suppression en masse des proxys désactivés.
    const purged = await call(ctx, 'DELETE', '/api/proxies?id=disabled', null, cookie);
    assert.equal(purged.data.removed, 1);
    assert.equal((await call(ctx, 'GET', '/api/proxies', null, cookie)).data.proxies.length, 2);
  } finally { await ctx.close(); }
});

test('proxys : aucune limite de nombre à l’import', async () => {
  const ctx = await startServer();
  try {
    const { cookie } = await call(ctx, 'POST', '/api/auth/register', { email: 'e@exemple.test', password: 'motdepasse-solide' });
    // 120 proxys : bien au-delà de l'ancienne limite de 100 de l'extension.
    const lines = Array.from({ length: 120 }, (_, index) => `proxy${index}.exemple.fr:${8000 + index}:identifiantfictif:motdepassefictif`);
    const imported = await call(ctx, 'POST', '/api/proxies', { text: lines.join('\n') }, cookie);
    assert.equal(imported.status, 201);
    assert.equal(imported.data.added, 120);
    assert.equal((await call(ctx, 'GET', '/api/proxies', null, cookie)).data.totals.count, 120);
  } finally { await ctx.close(); }
});

test('proxys : un import vide ou entièrement invalide est refusé', async () => {
  const ctx = await startServer();
  try {
    const { cookie } = await call(ctx, 'POST', '/api/auth/register', { email: 'f@exemple.test', password: 'motdepasse-solide' });
    assert.equal((await call(ctx, 'POST', '/api/proxies', { text: '   ' }, cookie)).status, 400);
    const invalid = await call(ctx, 'POST', '/api/proxies', { text: 'pas-un-proxy\nencore-moins' }, cookie);
    assert.equal(invalid.status, 400);
    assert.match(invalid.data.error, /Aucun proxy/);
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

test('proxys : la rotation alimente chaque cycle dans l’ordre, puis reboucle', async () => {
  const ctx = await startServer();
  try {
    const { cookie } = await call(ctx, 'POST', '/api/auth/register', { email: 'g@exemple.test', password: 'motdepasse-solide' });
    const lines = [1, 2, 3].map((index) => `proxy${index}.exemple.fr:${8000 + index}:identifiantfictif:motdepassefictif`);
    await call(ctx, 'POST', '/api/proxies', { text: lines.join('\n') }, cookie);

    // Réglage : rotation aléatoire puis retour à l'ordre.
    const random = await call(ctx, 'PATCH', '/api/proxies', { state: { rotation: 'random', enabled: true } }, cookie);
    assert.equal(random.data.state.rotation, 'random');
    const ordered = await call(ctx, 'PATCH', '/api/proxies', { state: { rotation: 'order', cursor: 0 } }, cookie);
    assert.equal(ordered.data.state.rotation, 'order');

    // La rotation est exposée en lecture pour l'interface.
    const listed = await call(ctx, 'GET', '/api/proxies', null, cookie);
    assert.equal(listed.data.state.enabled, true);
    assert.equal(listed.data.state.disableAfter, 3);
    assert.equal(listed.data.totals.enabled, 3);
  } finally { await ctx.close(); }
});

test('proxys : l’auto-désactivation survient après trois échecs consécutifs', async () => {
  const ctx = await startServer();
  try {
    const { cookie } = await call(ctx, 'POST', '/api/auth/register', { email: 'h@exemple.test', password: 'motdepasse-solide' });
    const user = ctx.store.listUsers()[0];
    await call(ctx, 'POST', '/api/proxies', { text: 'proxy1.exemple.fr:8000:identifiantfictif:motdepassefictif' }, cookie);
    const proxy = ctx.store.listProxies(user.id)[0];

    // Un succès remet le compteur à zéro.
    ctx.store.recordProxyOutcome(proxy.id, { success: true });
    assert.equal(ctx.store.getProxy(user.id, proxy.id).consecutive_failures, 0);

    let result;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      result = ctx.store.recordProxyOutcome(proxy.id, { success: false, error: 'timeout', disableAfter: 3 });
    }
    assert.equal(result.disabled, true, 'désactivé au troisième échec');
    assert.equal(ctx.store.getProxy(user.id, proxy.id).enabled, false);
    assert.equal(ctx.store.getProxy(user.id, proxy.id).last_error, 'timeout');
  } finally { await ctx.close(); }
});

test('proxys : réimporter la même liste ne produit pas d’erreur', async () => {
  const ctx = await startServer();
  try {
    const { cookie } = await call(ctx, 'POST', '/api/auth/register', { email: 'i@exemple.test', password: 'motdepasse-solide' });
    const text = 'proxy1.exemple.fr:8000:identifiantfictif:motdepassefictif';
    const first = await call(ctx, 'POST', '/api/proxies', { text }, cookie);
    assert.equal(first.status, 201);
    assert.equal(first.data.added, 1);
    const again = await call(ctx, 'POST', '/api/proxies', { text }, cookie);
    assert.equal(again.status, 200);
    assert.equal(again.data.added, 0);
    assert.equal(again.data.duplicates, 1);
    assert.match(again.data.message, /déjà dans la liste/);
  } finally { await ctx.close(); }
});

test('proxys : un fichier de plusieurs milliers de lignes passe (au-delà des 64 Ko par défaut)', async () => {
  const ctx = await startServer();
  try {
    const { cookie } = await call(ctx, 'POST', '/api/auth/register', { email: 'fichier@exemple.test', password: 'motdepasse-solide' });
    // 2000 lignes ≈ 125 Ko : impossible avant l'élargissement du corps JSON.
    const lines = [];
    for (let index = 1; index <= 2000; index += 1) {
      lines.push(`proxy${index}.exemple.fr:${8000 + (index % 1000)}:identifiantfictif:motdepassefictif`);
    }
    const text = lines.join('\r\n'); // fins de ligne Windows, comme un fichier .txt exporté
    assert.ok(text.length > 64 * 1024, 'le test doit dépasser l’ancienne limite');
    const imported = await call(ctx, 'POST', '/api/proxies', { text }, cookie);
    assert.equal(imported.status, 201);
    assert.equal(imported.data.added, 2000);
    const listed = await call(ctx, 'GET', '/api/proxies', null, cookie);
    assert.equal(listed.data.totals.count, 2000);
  } finally { await ctx.close(); }
});

test('proxys : un envoi au-delà de la limite est refusé avec un message explicite', async () => {
  const ctx = await startServer();
  try {
    const { cookie } = await call(ctx, 'POST', '/api/auth/register', { email: 'tropgros@exemple.test', password: 'motdepasse-solide' });
    const text = 'proxy.exemple.fr:8080:identifiantfictif:motdepassefictif\n'.repeat(60000);
    const rejected = await call(ctx, 'POST', '/api/proxies', { text }, cookie);
    assert.equal(rejected.status, 413);
    assert.match(rejected.data.error, /trop volumineux/i);
  } finally { await ctx.close(); }
});

test('proxys : un import partiel donne les numéros de ligne et un compte rendu honnête', async () => {
  const ctx = await startServer();
  try {
    const { cookie } = await call(ctx, 'POST', '/api/auth/register', { email: 'partiel@exemple.test', password: 'motdepasse-solide' });
    const lines = Array.from({ length: 10 }, (_, index) => `proxy${index + 1}.exemple.fr:${8000 + index}:identifiantfictif:motdepassefictif`);
    lines[3] = 'ceci-nest-pas-un-proxy';
    lines[7] = 'trop:de:champs:ici:encore';
    const imported = await call(ctx, 'POST', '/api/proxies', { text: lines.join('\n') }, cookie);
    assert.equal(imported.status, 201);
    assert.equal(imported.data.partial, true);
    // Les lignes mal formées doivent être localisables dans le fichier d'origine.
    const lines1 = imported.data.errors.map((error) => error.line).sort((a, b) => a - b);
    assert.deepEqual(lines1, [4, 8]);
    // Le total annoncé ne peut pas dépasser les 10 lignes du fichier.
    assert.match(imported.data.message, /sur 10\./);
  } finally { await ctx.close(); }
});
