import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createApp } from '../server/app.js';
import { loadConfig } from '../server/config.js';
import { openDatabase } from '../server/db.js';
import { createLogger } from '../server/logger.js';
import { clicksAllowedToday, plannedCountForDay, buildVisitSchedule, MAX_PER_DAY, MIN_CLICKS_PER_DAY } from '../server/schedule.js';
import { createStore } from '../server/store.js';
import { isSensitiveLabel } from '../server/worker.js';

const silentLogger = createLogger('error', { log() {}, warn() {}, error() {} });

test('au moins 100 clics par jour, même si le total saisi est plus faible', () => {
  assert.equal(MIN_CLICKS_PER_DAY, 100);
  // Plan de 40 clics sur la journée : le minimum quotidien prend le relais.
  assert.equal(clicksAllowedToday({ mode: 'interval', plannedToday: 40, doneToday: 0, remaining: 300 }), 100);
  // Quota du plan supérieur au minimum : il prime.
  assert.equal(clicksAllowedToday({ mode: 'interval', plannedToday: 150, doneToday: 0, remaining: 300 }), 150);
  // Quota du jour déjà atteint : plus rien aujourd'hui.
  assert.equal(clicksAllowedToday({ mode: 'interval', plannedToday: 150, doneToday: 150, remaining: 150 }), 0);
});

test('plafond de 288 clics par jour et rattrapage limité à 100', () => {
  assert.equal(MAX_PER_DAY, 288);
  // 280 déjà faits, 100 de retard : le plafond bloque à 8 clics de plus.
  assert.equal(clicksAllowedToday({ mode: 'interval', plannedToday: 280, doneToday: 280, backlog: 100, remaining: 900 }), 8);
  // 80 clics de retard : 100 de base + 80 de rattrapage.
  assert.equal(clicksAllowedToday({ mode: 'interval', plannedToday: 100, doneToday: 0, backlog: 80, remaining: 900 }), 180);
  // Le rattrapage ne dépasse jamais 100 clics.
  assert.equal(clicksAllowedToday({ mode: 'interval', plannedToday: 100, doneToday: 0, backlog: 500, remaining: 900 }), 200);
  // Mode objectif : pas de plafond quotidien, la série continue.
  assert.equal(clicksAllowedToday({ mode: 'goal', plannedToday: 0, doneToday: 0, remaining: 500 }), 500);
  // Plus rien à faire : 0, quel que soit le mode.
  assert.equal(clicksAllowedToday({ mode: 'goal', plannedToday: 0, doneToday: 0, remaining: 0 }), 0);
});

test('le calendrier respecte 5 minutes d’écart et le report sur le jour suivant', () => {
  const start = Date.now() + 60_000;
  const times = buildVisitSchedule({ effectiveTotal: 300, durationDays: 1, startAt: start });
  assert.equal(times.length, 300);
  for (let index = 1; index < times.length; index += 1) {
    assert.ok(times[index] - times[index - 1] >= 5 * 60 * 1000 - 1000, `écart ${index}`);
  }
  assert.equal(times[0], start, 'le premier créneau est celui demandé par l’appelant');
});

test('plannedCountForDay compte les visites d’une journée locale', () => {
  const start = Date.parse('2026-11-08T00:00:00Z');
  const scheduled = [start, start + 1000, start + 24 * 3600 * 1000].map((value) => new Date(value).toISOString());
  // Cotonou = UTC+1 : minuit UTC appartient déjà au 8 novembre local.
  assert.equal(plannedCountForDay(scheduled, 'Africa/Porto-Novo', '2026-11-08'), 2);
  assert.equal(plannedCountForDay(scheduled, 'Africa/Porto-Novo', '2026-11-09'), 1);
});

test('les libellés sensibles restent soumis à confirmation', () => {
  for (const label of ['Payer maintenant', 'Supprimer le compte', 'Se connecter', 'Valider', 'Envoyer']) {
    assert.equal(isSensitiveLabel(label), true, label);
  }
  for (const label of ['Découvrir la collection', 'Lire la suite', 'Voir le produit']) {
    assert.equal(isSensitiveLabel(label), false, label);
  }
});

test('la boucle exécute une visite et alimente le journal de clics', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'instava-engine-'));
  const config = loadConfig({
    DATA_DIR: dir,
    DATABASE_FILE: path.join(dir, 'engine.sqlite'),
    PUBLIC_DIR: path.join(process.cwd(), 'public'),
    INSTAVA_SECRET_KEY: 'cle-de-test-moteur',
    INSTAVA_TZ: 'Africa/Porto-Novo',
    INSTAVA_TICK_MS: '1000',
    INSTAVA_LOG_LEVEL: 'error',
    PORT: '0',
  });
  const db = openDatabase(config.databaseFile);
  const store = createStore(db);

  let cycles = 0;
  const fakeBrowser = { close: async () => {} };
  const { worker } = createApp({
    config,
    store,
    logger: silentLogger,
    startWorker: false,
    openBrowser: async () => fakeBrowser,
    runCycle: async () => {
      cycles += 1;
      return {
        initial_url: 'https://exemple.fr', final_url: 'https://exemple.fr/merci',
        title: 'Merci', click_label: 'Découvrir', click_kind: 'bouton', redirected: true,
      };
    },
  });

  try {
    const user = store.createUser({ email: 'moteur@exemple.test', passwordHash: 'x', role: 'owner' });
    const target = store.createTarget(user.id, {
      pseudo: 'Boutique', url: 'https://exemple.fr', link_label: 'Découvrir', mode: 'goal',
      execution_target: 2, duration_days: 1, effective_total: 2, daily_minimum: 0,
    });
    const past = new Date(Date.now() - 60_000).toISOString();
    const run = store.createRun(user.id, { confirmClicks: false, targetSnapshot: {} });
    store.addVisits([1, 2].map((index) => ({
      id: `visite-${index}`, run_id: run.id, user_id: user.id, target_id: target.id,
      pseudo_snapshot: 'Boutique', visit_number: index, scheduled_at: past,
    })));

    worker.start();
    const deadline = Date.now() + 6000;
    while (cycles < 2 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
    await worker.stop();

    assert.ok(cycles >= 1, `au moins un cycle exécuté (${cycles})`);
    const visits = store.listVisits(user.id);
    const succeeded = visits.filter((visit) => visit.status === 'success');
    assert.ok(succeeded.length >= 1);
    assert.equal(succeeded[0].result.click_kind, 'bouton');
    assert.equal(succeeded[0].result.final_url, 'https://exemple.fr/merci');

    // Le clic réussi est compté dans le journal du jour.
    const today = new Date().toISOString().slice(0, 10);
    const localToday = store.dailyClicksByTarget(user.id, target.id).find((row) => row.clicks > 0);
    assert.ok(localToday, `journal alimenté (${today})`);
    assert.ok(localToday.clicks >= 1);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('une visite sensible attend la confirmation avant tout clic', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'instava-approval-'));
  const config = loadConfig({
    DATA_DIR: dir,
    DATABASE_FILE: path.join(dir, 'approval.sqlite'),
    PUBLIC_DIR: path.join(process.cwd(), 'public'),
    INSTAVA_SECRET_KEY: 'cle-de-test-confirmation',
    INSTAVA_LOG_LEVEL: 'error',
    PORT: '0',
  });
  const db = openDatabase(config.databaseFile);
  const store = createStore(db);
  let cycles = 0;
  const { worker } = createApp({
    config, store, logger: silentLogger, startWorker: false,
    openBrowser: async () => ({ close: async () => {} }),
    runCycle: async () => { cycles += 1; return { final_url: 'https://exemple.fr/ok', redirected: true }; },
  });

  try {
    const user = store.createUser({ email: 'confirmation@exemple.test', passwordHash: 'x', role: 'owner' });
    const target = store.createTarget(user.id, {
      pseudo: 'Sensible', url: 'https://exemple.fr', link_label: 'Payer maintenant', mode: 'goal',
      execution_target: 1, duration_days: 1, effective_total: 1, daily_minimum: 0,
    });
    const run = store.createRun(user.id, { confirmClicks: false, targetSnapshot: {} });
    store.addVisits([{
      id: 'sensible-1', run_id: run.id, user_id: user.id, target_id: target.id,
      pseudo_snapshot: 'Sensible', visit_number: 1,
      scheduled_at: new Date(Date.now() - 60_000).toISOString(),
    }]);

    worker.start();
    const deadline = Date.now() + 5000;
    while (store.getVisit(user.id, 'sensible-1')?.status !== 'approval_required' && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(store.getVisit(user.id, 'sensible-1').status, 'approval_required');
    assert.equal(cycles, 0, 'aucun clic sans confirmation');

    worker.approve(user.id, 'sensible-1');
    const approved = store.getVisit(user.id, 'sensible-1');
    assert.equal(approved.status, 'pending');
    assert.ok(approved.approved_at);
    await worker.stop();
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('le calendrier ne déborde pas d’un jour et garde 5 minutes entre deux clics', () => {
  const start = Date.parse('2026-11-09T15:25:00Z');
  const scenarios = [[2, 1], [10, 1], [100, 1], [288, 1], [300, 3], [700, 7], [1000, 7]];
  for (const [count, days] of scenarios) {
    for (const random of [0, 0.37, 0.99]) {
      const times = buildVisitSchedule({ effectiveTotal: count, durationDays: days, startAt: start });
      assert.equal(times.length, count, `${count}/${days} : nombre d’horaires`);
      const gaps = times.slice(1).map((value, index) => value - times[index]);
      assert.ok(Math.min(...gaps) >= 5 * 60 * 1000 - 1000, `${count}/${days} : écart minimal ${Math.min(...gaps)}`);
      const lastDayIndex = Math.floor((times[times.length - 1] - start) / 86_400_000);
      if (count <= 288 * days) {
        assert.ok(lastDayIndex < days, `${count}/${days} : dernier clic au jour ${lastDayIndex}`);
      }
      assert.deepEqual([...times].sort((a, b) => a - b), times, 'horaires triés');
    }
  }
});

test('une demande de 2 clics part tout de suite, sans attendre 24 heures', () => {
  const start = Date.now() + 60_000;
  const times = buildVisitSchedule({ effectiveTotal: 2, durationDays: 1, startAt: start });
  assert.equal(times.length, 2);
  // Le second clic doit arriver dans la même journée, pas le lendemain.
  assert.ok(times[1] - start < 86_400_000, `second clic à +${Math.round((times[1] - start) / 3600000)} h`);
  assert.ok(times[1] - times[0] >= 5 * 60 * 1000 - 1000);
});

test('le mode objectif enchaîne les clics sans attendre 5 minutes', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'instava-goal-'));
  const config = loadConfig({
    DATA_DIR: dir,
    DATABASE_FILE: path.join(dir, 'goal.sqlite'),
    PUBLIC_DIR: path.join(process.cwd(), 'public'),
    INSTAVA_SECRET_KEY: 'cle-de-test-objectif',
    INSTAVA_TICK_MS: '300',
    INSTAVA_LOG_LEVEL: 'error',
    PORT: '0',
  });
  const db = openDatabase(config.databaseFile);
  const store = createStore(db);
  let cycles = 0;
  const { worker } = createApp({
    config, store, logger: silentLogger, startWorker: false,
    openBrowser: async () => ({ close: async () => {} }),
    runCycle: async () => {
      cycles += 1;
      return { final_url: 'https://exemple.fr/ok', click_kind: 'bouton', click_label: 'Go', redirected: true };
    },
  });

  try {
    const user = store.createUser({ email: 'serie@exemple.test', passwordHash: 'x', role: 'owner' });
    const target = store.createTarget(user.id, {
      pseudo: 'Série', url: 'https://exemple.fr', link_label: 'Go', mode: 'goal',
      execution_target: 4, duration_days: 1, effective_total: 4, daily_minimum: 0,
    });
    const run = store.createRun(user.id, { confirmClicks: false, targetSnapshot: {} });
    store.addVisits([1, 2, 3, 4].map((index) => ({
      id: `serie-${index}`, run_id: run.id, user_id: user.id, target_id: target.id,
      pseudo_snapshot: 'Série', visit_number: index,
      scheduled_at: new Date(Date.now() - 60_000 + index * 1000).toISOString(),
    })));

    worker.start();
    const deadline = Date.now() + 15_000;
    while (cycles < 4 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
    await worker.stop();

    // Avec l'écart de 5 minutes, un seul cycle aurait pu partir.
    assert.ok(cycles >= 3, `série enchaînée : ${cycles} cycles`);
    assert.equal(store.listVisits(user.id).filter((visit) => visit.status === 'success').length, cycles);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('les erreurs techniques sont traduites en actions compréhensibles', async () => {
  const { friendlyCycleError } = await import('../server/worker.js');
  const chromium = friendlyCycleError(new Error("browserType.launch: Executable doesn't exist at /root/.cache/ms-playwright/x"));
  assert.match(chromium, /Chromium n’est pas installé/);
  assert.ok(!chromium.includes('/root/'), 'aucun chemin interne exposé');
  assert.match(friendlyCycleError(new Error('page.goto: Timeout 45000ms exceeded.')), /n’a pas répondu à temps/);
  const business = 'Aucun lien ou bouton visible ne correspond exactement à « Acheter ».';
  assert.equal(friendlyCycleError(new Error(business)), business);
  assert.ok(!friendlyCycleError(new Error('échec sur https://secret.exemple.fr/x')).includes('secret.exemple.fr'));
});
