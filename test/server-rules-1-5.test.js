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
import { parseProxyImport, proxyRow, nextProxy, attachSecretKey } from '../server/proxies.js';
import { randomUUID } from 'node:crypto';

const silentLogger = createLogger('error', { log() {}, warn() {}, error() {} });

function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), 'instava-r15-'));
  const config = loadConfig({
    DATA_DIR: dir, DATABASE_FILE: path.join(dir, 'r.sqlite'),
    PUBLIC_DIR: path.join(process.cwd(), 'public'), INSTAVA_SECRET_KEY: 'cle-de-test-r15',
    INSTAVA_LOG_LEVEL: 'error', PORT: '0',
  });
  const db = openDatabase(config.databaseFile);
  const store = attachSecretKey(createStore(db), config.secretKey);
  const user = store.createUser({ email: 'r15@exemple.test', passwordHash: 'x', role: 'owner' });
  return { dir, config, db, store, user, clean: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

/* ---------------------------- règle 1 : l'IP ---------------------------- */

test('règle 1 : un proxy résidentiel testé passe avant toute la liste d’hébergeurs', () => {
  const ctx = setup();
  try {
    const parsed = parseProxyImport(['dc1', 'dc2', 'dc3', 'res1'].map((name, i) => `${name}.exemple.fr:80${i}:identifiantfictif:motdepassefictif`).join('\n'));
    ctx.store.insertProxies(ctx.user.id, parsed.entries.map((entry) => proxyRow(entry, ctx.config.secretKey, randomUUID(), entry.host)));
    const proxies = ctx.store.listProxies(ctx.user.id);
    for (const proxy of proxies) {
      ctx.store.setProxyIpInfo(ctx.user.id, proxy.id, {
        ipKind: proxy.host.startsWith('res') ? 'residential' : 'datacenter',
        asn: proxy.host.startsWith('res') ? 12322 : 16276,
        org: proxy.host,
      });
    }
    ctx.store.saveProxyState(ctx.user.id, { enabled: true, rotation: 'order' });

    for (let step = 0; step < 5; step += 1) {
      const picked = nextProxy(ctx.store, ctx.user.id);
      assert.equal(picked.proxy.host, 'res1.exemple.fr', 'le résidentiel est toujours choisi');
    }
  } finally { ctx.clean(); }
});

test('règle 1 : sans proxy résidentiel connu, la liste complète reste utilisée', () => {
  const ctx = setup();
  try {
    const parsed = parseProxyImport('dc1.exemple.fr:8080:identifiantfictif:motdepassefictif\ndc2.exemple.fr:8081:identifiantfictif:motdepassefictif');
    ctx.store.insertProxies(ctx.user.id, parsed.entries.map((entry) => proxyRow(entry, ctx.config.secretKey, randomUUID(), entry.host)));
    const proxies = ctx.store.listProxies(ctx.user.id);
    proxies.forEach((proxy) => ctx.store.setProxyIpInfo(ctx.user.id, proxy.id, { ipKind: 'datacenter', asn: 16276, org: 'OVH' }));
    ctx.store.saveProxyState(ctx.user.id, { enabled: true, rotation: 'order' });

    const seen = new Set();
    for (let step = 0; step < 4; step += 1) seen.add(nextProxy(ctx.store, ctx.user.id).proxy.host);
    assert.equal(seen.size, 2, 'aucun proxy n’est écarté faute de mieux');
  } finally { ctx.clean(); }
});

/* ---------------------- règle 5 : cookies par cible --------------------- */

test('règle 5 : les cookies ne sont conservés que pour le domaine de la cible', () => {
  const ctx = setup();
  try {
    const target = ctx.store.createTarget(ctx.user.id, {
      pseudo: 'Boutique', url: 'https://boutique.exemple.fr/produit', link_label: '', mode: 'goal',
      execution_target: 2, duration_days: 1, effective_total: 2, daily_minimum: 0,
    });
    const state = {
      cookies: [
        { name: 'cf_clearance', value: 'x', domain: '.exemple.fr', path: '/' },
        { name: 'session', value: 'y', domain: 'boutique.exemple.fr', path: '/' },
        { name: 'tracker', value: 'z', domain: '.doubleclick.net', path: '/' },
      ],
      origins: [],
    };
    // La même logique que le worker : on ne garde que le site visé.
    const siteHost = new URL(target.url).hostname;
    const relevant = state.cookies.filter((cookie) => {
      const domain = String(cookie.domain || '').replace(/^\./, '');
      return siteHost === domain || siteHost.endsWith(`.${domain}`);
    });
    ctx.store.saveTargetSession(ctx.user.id, target.id, { cookies: relevant, origins: [] }, relevant.length);

    const stored = ctx.store.getTargetSession(ctx.user.id, target.id);
    assert.equal(stored.cookieCount, 2);
    assert.deepEqual(stored.storage.cookies.map((cookie) => cookie.name), ['cf_clearance', 'session']);
    assert.ok(!stored.storage.cookies.some((cookie) => cookie.name === 'tracker'), 'cookie de traqueur écarté');

    // Effacement manuel.
    assert.equal(ctx.store.deleteTargetSession(ctx.user.id, target.id), 1);
    assert.equal(ctx.store.getTargetSession(ctx.user.id, target.id), null);
  } finally { ctx.clean(); }
});

test('règle 5 : le cycle suivant reçoit les cookies du précédent et les renvoie mis à jour', async () => {
  const ctx = setup();
  try {
    const target = ctx.store.createTarget(ctx.user.id, {
      pseudo: 'Cible', url: 'https://exemple.fr/page', link_label: '', mode: 'goal',
      execution_target: 2, duration_days: 1, effective_total: 2, daily_minimum: 0,
    });
    const past = new Date(Date.now() - 60_000).toISOString();
    const run = ctx.store.createRun(ctx.user.id, { confirmClicks: false, targetSnapshot: {} });
    ctx.store.addVisits([1, 2].map((index) => ({
      id: `session-${index}`, run_id: run.id, user_id: ctx.user.id, target_id: target.id,
      pseudo_snapshot: 'Cible', visit_number: index, scheduled_at: past,
    })));

    const received = [];
    let cycles = 0;
    const { worker } = createApp({
      config: ctx.config, store: ctx.store, logger: silentLogger, startWorker: false,
      openBrowser: async () => ({ close: async () => {} }),
      runCycle: async ({ storageState, onStorageState }) => {
        cycles += 1;
        received.push(storageState);
        // Le cycle « visite » le site et laisse un cookie de clearance.
        onStorageState?.({ cookies: [{ name: 'cf_clearance', value: `v${cycles}`, domain: '.exemple.fr', path: '/' }], origins: [] });
        return { initial_url: 'https://exemple.fr/page', final_url: 'https://exemple.fr/ok', title: 'OK', click_label: 'Voir', click_kind: 'bouton', redirected: true };
      },
    });

    worker.start();
    const deadline = Date.now() + 20000;
    while (cycles < 2 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 150));
    await worker.stop();

    assert.equal(cycles, 2, `deux cycles exécutés (${cycles})`);
    assert.equal(received[0], null, 'le premier cycle part sans cookie');
    assert.ok(received[1], 'le second cycle reçoit la session du premier');
    assert.equal(received[1].cookies[0].name, 'cf_clearance');
    assert.equal(received[1].cookies[0].value, 'v1', 'la valeur conservée vient du premier cycle');
  } finally { ctx.clean(); }
});

test('règle 3 : le diagnostic d’empreinte est cohérent et dit ce qu’il ne mesure pas', async () => {
  const { fingerprintFromProfile, contextProfile, engineVersionFrom, describeFingerprint } = await import('../server/stealth.js');
  const { readFileSync } = await import('node:fs');
  const version = engineVersionFrom(JSON.parse(readFileSync(new URL('../node_modules/playwright-core/browsers.json', import.meta.url), 'utf8')));
  assert.ok(version, 'la version du moteur doit être lisible');

  const diagnostic = fingerprintFromProfile(contextProfile(version), false);
  assert.equal(diagnostic.ok, true, `empreinte incohérente : ${diagnostic.issues.join('; ')}`);
  assert.equal(diagnostic.uaVersion, diagnostic.hintVersion);
  assert.match(diagnostic.note, /JA3/, 'la limite du diagnostic est annoncée');

  // L'ancien bug (UA 131 face à un moteur 158) doit rester détectable.
  const broken = describeFingerprint({
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    hints: { 'sec-ch-ua': '"Chromium";v="158", "Google Chrome";v="158"', 'sec-ch-ua-platform': '"Linux"' },
    webdriver: true,
    viewport: { width: 1366, height: 768 },
    locales: ['fr-FR'],
    timezone: 'Africa/Porto-Novo',
  });
  assert.equal(broken.ok, false);
  assert.ok(broken.issues.some((issue) => /incohérente/i.test(issue)));
  assert.ok(broken.issues.some((issue) => /webdriver/i.test(issue)));
});

test('règle 1 et 5 : la route de diagnostic expose IP et sessions', async () => {
  const ctx = setup();
  const { server } = createApp({ config: ctx.config, store: ctx.store, logger: silentLogger, startWorker: false });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const register = await fetch(`${base}/api/auth/register`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'diag@exemple.test', password: 'motdepasse-solide' }),
    });
    const cookie = register.headers.getSetCookie()[0].split(';')[0];

    // Le compte créé par la requête HTTP, pas celui du décor.
    const owner = ctx.store.listUsers().find((item) => item.email === 'diag@exemple.test');
    assert.ok(owner, 'compte inscrit retrouvé');
    const parsed = parseProxyImport('dc.exemple.fr:8080:identifiantfictif:motdepassefictif');
    ctx.store.insertProxies(owner.id, parsed.entries.map((entry) => proxyRow(entry, ctx.config.secretKey, randomUUID(), 'DC')));
    const [proxy] = ctx.store.listProxies(owner.id);
    ctx.store.setProxyIpInfo(owner.id, proxy.id, { ipKind: 'datacenter', asn: 16276, org: 'OVH' });

    const response = await fetch(`${base}/api/diagnostic`, { headers: { cookie } });
    const raw = await response.text();
    assert.equal(response.status, 200, `corps : ${raw.slice(0, 300)}`);
    const data = JSON.parse(raw);
    assert.equal(data.proxies.datacenter, 1);
    assert.equal(data.proxies.residential, 0);
    assert.equal(data.proxies.priority, false);
    assert.match(data.rules.ip, /Aucun proxy résidentiel/);
    assert.equal(data.fingerprint.ok, true);
  } finally {
    server.close();
    ctx.clean();
  }
});
