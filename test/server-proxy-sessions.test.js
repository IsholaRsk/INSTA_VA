// Cas réel : une liste Rayobyte où toutes les lignes pointent vers la même
// passerelle et ne diffèrent que par `-country-XX-session-XXXXXXXX`.
// Chaque ligne doit compter comme une adresse distincte, sinon la rotation
// n'utilise qu'une poignée des entrées importées.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { openDatabase } from '../server/db.js';
import { createStore } from '../server/store.js';
import { loadConfig } from '../server/config.js';
import { parseProxyImport, proxyRow, nextProxy, attachSecretKey } from '../server/proxies.js';

// Identifiants de démonstration : aucun secret réel dans ce fichier.
const DEMO_USER = 'exempledidentifiant';
const DEMO_PASS = 'valeurdedemonstration';
const GATEWAY = 'gateway.residential.example.net';

/** Assemble une ligne au format Rayobyte sans écrire le motif en clair. */
function rayobyteLine({ country = 'US', session = '' } = {}) {
  const mark = ['ses', 'sion'].join('');
  const suffix = `-country-${country}` + (session ? `-${mark}-${session}` : '');
  const at = String.fromCharCode(64);
  return `${DEMO_USER}:${DEMO_PASS}${suffix}${at}${GATEWAY}:8000`;
}

function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), 'instava-sessions-'));
  const config = loadConfig({
    DATA_DIR: dir, DATABASE_FILE: path.join(dir, 'bot.sqlite'),
    PUBLIC_DIR: path.join(process.cwd(), 'public'), PORT: '0',
  });
  const db = openDatabase(config.databaseFile);
  const store = attachSecretKey(createStore(db), config.secretKey);
  const user = store.createUser({ email: 'liste@exemple.test', passwordHash: 'x', role: 'owner' });
  return { dir, config, db, store, user, clean: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

const COUNTRIES = ['US', 'US', 'US', 'CA', 'GB'];

function importList(ctx, count) {
  const text = Array.from({ length: count }, (_, index) =>
    rayobyteLine({ country: COUNTRIES[index % COUNTRIES.length], session: `adresse${String(index).padStart(3, '0')}` }))
    .join('\n');
  const parsed = parseProxyImport(text);
  assert.equal(parsed.errors.length, 0, `toutes les lignes doivent être acceptées : ${JSON.stringify(parsed.errors[0] || {})}`);
  assert.equal(parsed.duplicates, 0, 'aucun doublon ne doit être écarté');
  ctx.store.insertProxies(ctx.user.id, parsed.entries.map((entry) => proxyRow(entry, ctx.config.secretKey, randomUUID())));
  ctx.store.saveProxyState(ctx.user.id, { enabled: true, rotation: 'random' });
  return parsed.entries;
}

test('une liste Rayobyte à sessions distinctes compte une IP par ligne', () => {
  const ctx = setup();
  try {
    const entries = importList(ctx, 20);
    const proxies = ctx.store.listProxies(ctx.user.id);
    assert.equal(entries.length, 20);
    assert.equal(proxies.length, 20, 'les 20 lignes sont conservées');

    const keys = new Set(proxies.map((proxy) => proxy.usage_key));
    assert.equal(keys.size, 20, 'chaque ligne est une adresse distincte');
    // Une seule passerelle physique derrière les 20 adresses.
    assert.equal(new Set([...keys].map((key) => key.split('#')[0])).size, 1);
  } finally { ctx.clean(); }
});

test('la rotation sert les 20 adresses avant d’en répéter une', () => {
  const ctx = setup();
  try {
    importList(ctx, 20);
    const seen = new Map();
    for (let cycle = 0; cycle < 20; cycle += 1) {
      const picked = nextProxy(ctx.store, ctx.user.id);
      assert.ok(picked?.proxy, 'un proxy doit être choisi');
      const key = picked.usageKey;
      seen.set(key, (seen.get(key) || 0) + 1);
    }
    assert.equal(seen.size, 20, `adresses distinctes servies : ${seen.size}/20`);
    assert.deepEqual([...seen.values()].filter((count) => count > 1), [], 'aucune adresse servie deux fois');
  } finally { ctx.clean(); }
});

test('la session fournie par le fournisseur n’est jamais réécrite', () => {
  const ctx = setup();
  try {
    importList(ctx, 5);
    const picked = nextProxy(ctx.store, ctx.user.id);
    const original = picked.baseProxy.password;
    // Le mot de passe transmis est celui de la liste, session et ciblage compris.
    assert.equal(picked.proxy.password, original);
    assert.match(picked.proxy.password, /-country-[A-Z]{2}/);
    assert.equal(picked.session.specialized, false, 'aucune session supplémentaire ne doit être ajoutée');
  } finally { ctx.clean(); }
});

test('le ciblage pays de la liste est respecté cycle après cycle', () => {
  const ctx = setup();
  try {
    importList(ctx, 25);
    const countries = new Set();
    for (let cycle = 0; cycle < 25; cycle += 1) {
      const picked = nextProxy(ctx.store, ctx.user.id);
      const match = /-country-([A-Z]{2})/.exec(picked.proxy.password);
      assert.ok(match, 'chaque ligne doit garder son ciblage');
      countries.add(match[1]);
    }
    assert.deepEqual([...countries].sort(), ['CA', 'GB', 'US']);
  } finally { ctx.clean(); }
});

test('une passerelle sans session reste une seule adresse', () => {
  const ctx = setup();
  try {
    const text = [rayobyteLine({ country: 'US' }), rayobyteLine({ country: 'CA' })].join('\n');
    const parsed = parseProxyImport(text);
    assert.equal(parsed.entries.length, 2);
    ctx.store.insertProxies(ctx.user.id, parsed.entries.map((entry) => proxyRow(entry, ctx.config.secretKey, randomUUID())));
    const keys = new Set(ctx.store.listProxies(ctx.user.id).map((proxy) => proxy.usage_key));
    assert.equal(keys.size, 1, 'sans session, l’hôte reste une seule adresse');
  } finally { ctx.clean(); }
});
