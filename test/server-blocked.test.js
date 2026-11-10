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
import { detectChallengeSnapshot, detectBlockedSnapshot } from '../server/challenge.js';
import { ChallengeError } from '../server/browser.js';
import { friendlyCycleError } from '../server/worker.js';

const silentLogger = createLogger('error', { log() {}, warn() {}, error() {} });

// Page réelle telle qu'elle apparaît dans la capture : erreur 1020.
const BLOCKED_PAGE = {
  title: 'Sorry, you have been blocked',
  html: '<html><body><h1>Sorry, you have been blocked</h1>'
    + '<h2>You are unable to access onlyfans.com</h2><p>Error code: 1020</p></body></html>',
  url: 'https://onlyfans.com/',
};

test('le blocage pare-feu est reconnu comme tel, pas comme un challenge', () => {
  const result = detectChallengeSnapshot(BLOCKED_PAGE);
  assert.ok(result, 'la page doit être détectée');
  assert.equal(result.kind, 'blocked', 'un blocage définitif n’est pas un challenge');

  // Reconnaissance par le code seul, même si le titre est traduit.
  assert.equal(detectBlockedSnapshot({ html: '<p>Error code: 1020</p>' })?.kind, 'blocked');
  assert.equal(detectBlockedSnapshot({ title: 'Désolé, vous avez été bloqué' })?.kind, 'blocked');
});

test('un challenge et un blocage ne se confondent pas dans les deux sens', () => {
  assert.equal(detectChallengeSnapshot({ title: 'Just a moment...' }).kind, 'cloudflare');
  assert.equal(detectBlockedSnapshot({ title: 'Just a moment...' }), null);
  assert.equal(detectBlockedSnapshot({ title: 'Boutique — Accueil', html: '<a href="/x">Acheter</a>' }), null);
  // Une 5xx Cloudflare ne doit pas devenir un blocage.
  assert.equal(detectChallengeSnapshot({ title: 'Cloudflare 522', html: '<div id="cf-error-details">Timeout</div>' }), null);
});

test('le message d’un blocage ne promet pas un déblocage', () => {
  const message = friendlyCycleError(new ChallengeError({ kind: 'blocked' }, 403));
  assert.match(message, /1020/);
  assert.match(message, /rien ne se débloquera/);
  assert.match(message, /résidentiel/);
  assert.doesNotMatch(message, /Libellé|libellé introuvable/);

  // Un challenge, lui, garde son message d'attente.
  const challenge = friendlyCycleError(new ChallengeError({ kind: 'cloudflare' }, 403));
  assert.match(challenge, /page de vérification Cloudflare/);
});

async function startEngine() {
  const dir = mkdtempSync(path.join(tmpdir(), 'instava-blocked-'));
  const config = loadConfig({
    DATA_DIR: dir,
    DATABASE_FILE: path.join(dir, 'b.sqlite'),
    PUBLIC_DIR: path.join(process.cwd(), 'public'),
    INSTAVA_SECRET_KEY: 'cle-de-test-blocage',
    INSTAVA_TZ: 'Africa/Porto-Novo',
    INSTAVA_TICK_MS: '600',
    INSTAVA_LOG_LEVEL: 'error',
    PORT: '0',
  });
  const db = openDatabase(config.databaseFile);
  const store = createStore(db);
  return { dir, config, db, store };
}

test('un refus pare-feu n’impute rien au proxy : la liste reste intacte', async () => {
  const ctx = await startEngine();
  try {
    // Un proxy enregistré, qui n'a rien à voir avec le refus du site.
    const { parseProxyImport, proxyRow } = await import('../server/proxies.js');
    const { randomUUID } = await import('node:crypto');
    const user = ctx.store.createUser({ email: 'blocage@exemple.test', passwordHash: 'x', role: 'owner' });
    const parsed = parseProxyImport('proxy.exemple.fr:8080:identifiantfictif:motdepassefictif');
    ctx.store.insertProxies(user.id, parsed.entries.map((entry) => proxyRow(entry, ctx.config.secretKey, randomUUID(), 'P1')));
    ctx.store.saveProxyState(user.id, { enabled: true });

    const target = ctx.store.createTarget(user.id, {
      pseudo: 'OnlyFans', url: 'https://onlyfans.com', link_label: '', mode: 'goal',
      execution_target: 4, duration_days: 1, effective_total: 4, daily_minimum: 0,
    });
    const past = new Date(Date.now() - 60_000).toISOString();
    const run = ctx.store.createRun(user.id, { confirmClicks: false, targetSnapshot: {} });
    ctx.store.addVisits([1, 2, 3, 4].map((index) => ({
      id: `blocage-${index}`, run_id: run.id, user_id: user.id, target_id: target.id,
      pseudo_snapshot: 'OnlyFans', visit_number: index, scheduled_at: past,
    })));

    let cycles = 0;
    const { worker } = createApp({
      config: ctx.config, store: ctx.store, logger: silentLogger, startWorker: false,
      openBrowser: async () => ({ close: async () => {} }),
      runCycle: async () => { cycles += 1; throw new ChallengeError({ kind: 'blocked' }, 403); },
    });

    worker.start();
    // L'écart entre deux cycles d'une même cible est de 1,5 à 3,5 s : il faut
    // laisser le temps aux trois refus de s'enchaîner. On attend l'annulation
    // plutôt qu'un nombre de cycles, puisque c'est justement l'arrêt qu'on teste.
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const seen = ctx.store.listVisits(user.id);
      if (seen.every((visit) => visit.status !== 'pending' && visit.status !== 'running')) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await worker.stop();

    const proxies = ctx.store.listProxies(user.id);
    assert.equal(proxies[0].enabled, true, 'le proxy ne doit pas être désactivé par un refus du site');
    assert.equal(proxies[0].consecutive_failures, 0, 'aucun échec imputé au proxy');

    const visits = ctx.store.listVisits(user.id);
    // Plus d'arrêt de série : les quatre visites sont tentées, aucune annulée.
    const cancelled = visits.filter((visit) => visit.status === 'cancelled');
    assert.equal(cancelled.length, 0, 'aucune visite n’est annulée sur un refus du site');
    const failed = visits.filter((visit) => visit.status === 'failed');
    assert.equal(failed.length, 4, `les quatre visites sont tentées (${failed.length})`);
    assert.match(failed[0].result.message, /1020/);
  } finally {
    ctx.db.close();
    rmSync(ctx.dir, { recursive: true, force: true });
  }
});

test('une visite bloquée est réessayée sur plusieurs IP avant d’abandonner', async () => {
  const ctx = await startEngine();
  try {
    const { parseProxyImport, proxyRow } = await import('../server/proxies.js');
    const { randomUUID } = await import('node:crypto');
    const user = ctx.store.createUser({ email: 'retry@exemple.test', passwordHash: 'x', role: 'owner' });
    const lines = ['a', 'b', 'c'].map((name, index) => `${name}.exemple.fr:90${index}0:identifiantfictif:motdepassefictif`);
    const parsed = parseProxyImport(lines.join('\n'));
    ctx.store.insertProxies(user.id, parsed.entries.map((entry) => proxyRow(entry, ctx.config.secretKey, randomUUID(), entry.host)));
    ctx.store.saveProxyState(user.id, { enabled: true, rotation: 'order' });

    const target = ctx.store.createTarget(user.id, {
      pseudo: 'Cible', url: 'https://exemple.fr', link_label: '', mode: 'goal',
      execution_target: 1, duration_days: 1, effective_total: 1, daily_minimum: 0,
    });
    const run = ctx.store.createRun(user.id, { confirmClicks: false, targetSnapshot: {} });
    ctx.store.addVisits([{ id: 'retry-1', run_id: run.id, user_id: user.id, target_id: target.id,
      pseudo_snapshot: 'Cible', visit_number: 1, scheduled_at: new Date(Date.now() - 60_000).toISOString() }]);

    const hosts = [];
    const { worker } = createApp({
      config: { ...ctx.config, proxyAttempts: 3 }, store: ctx.store, logger: silentLogger, startWorker: false,
      openBrowser: async () => ({ close: async () => {} }),
      runCycle: async ({ proxy }) => {
        hosts.push(proxy?.host || 'direct');
        throw new ChallengeError({ kind: 'cloudflare' }, 403);
      },
    });

    worker.start();
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      const [visit] = ctx.store.listVisits(user.id);
      if (visit.status === 'failed') break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await worker.stop();

    assert.equal(hosts.length, 3, `trois tentatives (${hosts.length})`);
    assert.equal(new Set(hosts).size, 3, 'chaque tentative passe par une IP différente');
    assert.equal(ctx.store.listVisits(user.id)[0].status, 'failed');
  } finally {
    ctx.db.close();
    rmSync(ctx.dir, { recursive: true, force: true });
  }
});
