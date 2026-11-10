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

function setup(env = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'instava-resil-'));
  const config = loadConfig({
    DATA_DIR: dir, DATABASE_FILE: path.join(dir, 'r.sqlite'),
    PUBLIC_DIR: path.join(process.cwd(), 'public'), INSTAVA_SECRET_KEY: 'cle-de-test-resilience',
    INSTAVA_LOG_LEVEL: 'error', PORT: '0', ...env,
  });
  const db = openDatabase(config.databaseFile);
  const store = createStore(db);
  return { dir, config, db, store, clean: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

function seedTarget(store, { count = 2 } = {}) {
  const user = store.createUser({ email: `res-${count}-${Math.random().toString(36).slice(2, 8)}@exemple.test`, passwordHash: 'x', role: 'owner' });
  const target = store.createTarget(user.id, {
    pseudo: 'Cible', url: 'https://exemple.fr', link_label: 'Go', mode: 'goal',
    execution_target: count, duration_days: 1, effective_total: count, daily_minimum: 0,
  });
  const run = store.createRun(user.id, { confirmClicks: false, targetSnapshot: {} });
  const past = new Date(Date.now() - 60_000).toISOString();
  store.addVisits(Array.from({ length: count }, (_, index) => ({
    id: `res-${user.id.slice(0, 6)}-${index}`, run_id: run.id, user_id: user.id, target_id: target.id,
    pseudo_snapshot: 'Cible', visit_number: index + 1, scheduled_at: past,
  })));
  return { user, target, run };
}

test('une fenêtre morte est relancée et la série continue', async () => {
  const ctx = setup();
  try {
    const { user } = seedTarget(ctx.store, { count: 3 });
    let launches = 0;
    let allowed = new Set(['b1']);
    let cycles = 0;

    const fakeBrowser = (name) => ({
      isConnected: () => allowed.has(name),
      on: () => {},
      close: async () => { allowed.delete(name); },
    });

    const { worker } = createApp({
      config: ctx.config, store: ctx.store, logger: silentLogger, startWorker: false,
      openBrowser: async () => {
        launches += 1;
        const name = `b${launches}`;
        allowed.add(name);
        return fakeBrowser(name);
      },
      runCycle: async ({ browser }) => {
        cycles += 1;
        // Le deuxième cycle trouve une fenêtre morte : erreur de contexte fermé.
        if (cycles === 2) {
          allowed.clear();
          throw new Error('Target page, context or browser has been closed');
        }
        assert.ok(browser.isConnected(), 'le cycle doit disposer d’une fenêtre vivante');
        return { final_url: 'https://exemple.fr/ok', click_kind: 'bouton', click_label: 'Go', redirected: true };
      },
    });

    worker.start();
    const deadline = Date.now() + 25000;
    while (Date.now() < deadline) {
      const visits = ctx.store.listVisits(user.id);
      if (visits.every((visit) => !['pending', 'running'].includes(visit.status))) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    // La boucle tourne encore à ce stade : c'est justement ce qu'on vérifie.
    const stillRunning = worker.isRunning;
    const stats = worker.stats;
    await worker.stop();

    const visits = ctx.store.listVisits(user.id);
    assert.equal(visits.filter((visit) => visit.status === 'success').length, 2, 'les visites hors incident aboutissent');
    assert.equal(visits.filter((visit) => visit.status === 'failed').length, 1, 'la visite interrompue est consignée');
    assert.ok(launches >= 2, `un nouveau navigateur est lancé après la mort du premier (${launches})`);
    assert.ok(stats.restarts >= 1, 'le redémarrage est compté');
    assert.equal(stillRunning, true, 'la boucle n’est jamais arrêtée par un incident');
  } finally { ctx.clean(); }
});

test('la boucle survit à une erreur du planificateur', async () => {
  const ctx = setup();
  try {
    let ticks = 0;
    const brokenScheduler = {
      ownersWithWork: () => { ticks += 1; throw new Error('base momentanément indisponible'); },
      nextRunnable: () => null,
      markCycleDone: () => {},
      targetProgress: () => ({ done: 0, pending: 0 }),
    };
    const { worker } = createApp({
      config: { ...ctx.config, tickMs: 60 }, store: ctx.store, logger: silentLogger, startWorker: false,
      scheduler: brokenScheduler,
      openBrowser: async () => ({ close: async () => {} }),
      runCycle: async () => ({}),
    });
    worker.start();
    await new Promise((resolve) => setTimeout(resolve, 500));
    await worker.stop();
    assert.ok(ticks >= 2, `la boucle a repris après l’erreur (${ticks} ticks)`);
  } finally { ctx.clean(); }
});

test('/api/health expose l’état du bot et ses compteurs', async () => {
  const ctx = setup();
  const { server } = createApp({
    config: ctx.config, store: ctx.store, logger: silentLogger, startWorker: false,
    openBrowser: async () => ({ isConnected: () => true, on: () => {}, close: async () => {} }),
    runCycle: async () => ({}),
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const response = await fetch(`${base}/api/health`);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(typeof body.worker.running, 'boolean');
    assert.equal(typeof body.worker.active, 'number');
    assert.equal(typeof body.worker.restarts, 'number');
    assert.equal(typeof body.worker.blockedVisits, 'number');
  } finally {
    server.close();
    ctx.clean();
  }
});
