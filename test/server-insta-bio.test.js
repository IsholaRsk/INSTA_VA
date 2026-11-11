import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { createApp } from '../server/app.js';
import { loadConfig } from '../server/config.js';
import { openDatabase } from '../server/db.js';
import { createStore } from '../server/store.js';
import { createLogger } from '../server/logger.js';
import { attachSecretKey, existingProxySignatures, parseProxyImport, proxyGatewayHint, proxyRow } from '../server/proxies.js';
import { unwrapRedirectUrl, clickableCollectorSource } from '../server/browser.js';

const silentLogger = createLogger('error', { log() {}, warn() {}, error() {} });

function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), 'instava-bio-'));
  const config = loadConfig({
    DATA_DIR: dir, DATABASE_FILE: path.join(dir, 'b.sqlite'),
    PUBLIC_DIR: path.join(process.cwd(), 'public'), INSTAVA_SECRET_KEY: 'cle-de-test-bio',
    INSTAVA_LOG_LEVEL: 'error', PORT: '0',
  });
  const db = openDatabase(config.databaseFile);
  const store = attachSecretKey(createStore(db), config.secretKey);
  return { dir, config, db, store, clean: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

/* ------------------- format Rayobyte : user:pass@host:port ------------------ */

test('le format Rayobyte user:pass@host:port est accepté tel quel', () => {
  const line = 'uti1lisateurfictif:motdepassefictif-country-US@us-east.gw.rayobyte.com:8000';
  const result = parseProxyImport(line);
  assert.equal(result.errors.length, 0, `rejeté : ${result.errors[0]?.message}`);
  assert.equal(result.entries.length, 1);
  const [entry] = result.entries;
  assert.equal(entry.host, 'us-east.gw.rayobyte.com');
  assert.equal(entry.port, 8000);
  assert.equal(entry.username, 'uti1lisateurfictif');
  // Le mot de passe contient un tiret et un suffixe de pays : il doit rester intact.
  assert.equal(entry.password, 'motdepassefictif-country-US');
});

test('plusieurs lignes Rayobyte donnent plusieurs proxys distincts', () => {
  const lines = [8000, 8001, 8002].map((port) =>
    `uti1lisateurfictif:motdepassefictif-country-US@us-east.gw.rayobyte.com:${port}`);
  const result = parseProxyImport(lines.join('\n'));
  assert.equal(result.entries.length, 3);
  assert.equal(result.errors.length, 0);
  assert.deepEqual(result.entries.map((entry) => entry.port), [8000, 8001, 8002]);
});

test('le format avec / et paramètres (copié depuis un mail) est nettoyé', () => {
  const line = 'uti1lisateurfictif:motdepassefictif-country-US@us-east.gw.rayobyte.com:8000/';
  const result = parseProxyImport(line);
  assert.equal(result.errors.length, 0);
  assert.equal(result.entries[0].port, 8000);
  assert.equal(result.entries[0].host, 'us-east.gw.rayobyte.com');
});

test('les sessions sticky Rayobyte sur la même passerelle et le même port ne sont pas fusionnées', () => {
  const lines = ['s1a2b3', 's4c5d6', 's7e8f9'].map((sid) =>
    `la.residential.rayobyte.com:8000:uti1lisateurfictif:motdepassefictif-country-FR-session-${sid}`);
  const result = parseProxyImport(lines.join('\n'));
  assert.equal(result.errors.length, 0);
  assert.equal(result.duplicates, 0);
  assert.equal(result.entries.length, 3);
  assert.equal(proxyGatewayHint(result.entries[0]), 'FR · session s1a2b3');
  assert.ok(!proxyGatewayHint(result.entries[0]).includes('motdepassefictif'), 'aucun secret exposé dans l’indice');

  // Une vraie ligne dupliquée (même session) reste détectée comme doublon.
  const withDup = parseProxyImport([...lines, lines[1]].join('\n'));
  assert.equal(withDup.entries.length, 3);
  assert.equal(withDup.duplicates, 1);
});

test('les identifiants Rayobyte contenant @ (e-mail) dans host:port:user:pass sont acceptés', () => {
  const samples = [
    [
      'la.residential.rayobyte.com:8000:client@domaine.fr:motdepassefictif-country-US',
      'la.residential.rayobyte.com', 8000, 'client@domaine.fr', 'motdepassefictif-country-US',
    ],
    [
      'la.residential.rayobyte.com:8000:client@domaine.fr:1234',
      'la.residential.rayobyte.com', 8000, 'client@domaine.fr', '1234',
    ],
    [
      'la.residential.rayobyte.com:8000:uti1lisateurfictif:mot@passe-country-FR',
      'la.residential.rayobyte.com', 8000, 'uti1lisateurfictif', 'mot@passe-country-FR',
    ],
    [
      'client@domaine.fr:motdepassefictif-country-US@us-east.gw.rayobyte.com:8000',
      'us-east.gw.rayobyte.com', 8000, 'client@domaine.fr', 'motdepassefictif-country-US',
    ],
  ];
  for (const [line, host, port, username, password] of samples) {
    const result = parseProxyImport(line);
    assert.equal(result.errors.length, 0, `${line} rejeté : ${result.errors[0]?.message}`);
    assert.equal(result.entries.length, 1);
    assert.equal(result.entries[0].host, host);
    assert.equal(result.entries[0].port, port);
    assert.equal(result.entries[0].username, username);
    assert.equal(result.entries[0].password, password);
  }
});

test('les séparateurs « , », « ; » et tabulations sont acceptés sans couper les mots de passe', () => {
  const separated = parseProxyImport(
    'uti1lisateurfictif:motdepassefictif-session-1@us-east.gw.rayobyte.com:8000, '
    + 'uti1lisateurfictif:motdepassefictif-session-2@us-east.gw.rayobyte.com:8000; '
    + 'us-east.gw.rayobyte.com\t8001\tuti1lisateurfictif\tmotdepassefictif',
  );
  assert.equal(separated.errors.length, 0);
  assert.equal(separated.entries.length, 3);

  const semicolonPass = parseProxyImport('us-east.gw.rayobyte.com:8000:uti1lisateurfictif:mot;de,passe');
  assert.equal(semicolonPass.errors.length, 0);
  assert.equal(semicolonPass.entries.length, 1);
  assert.equal(semicolonPass.entries[0].password, 'mot;de,passe');
});

test('les signatures existantes côté serveur distinguent les sessions sticky Rayobyte', () => {
  const ctx = setup();
  try {
    const owner = ctx.store.createUser({ email: 'gw@exemple.test', passwordHash: 'h', role: 'owner' });
    const lines = ['a1', 'b2'].map((sid) =>
      `uti1lisateurfictif:motdepassefictif-country-US-session-${sid}@us-east.gw.rayobyte.com:8000`);
    const parsed = parseProxyImport(lines.join('\n'));
    ctx.store.insertProxies(owner.id, parsed.entries.map((entry) =>
      proxyRow(entry, ctx.config.secretKey, randomUUID(), proxyGatewayHint(entry))));
    const signatures = existingProxySignatures(ctx.store, owner.id, ctx.config.secretKey);
    assert.equal(signatures.size, 2);
  } finally {
    ctx.clean();
  }
});

/* ------------------------ vidage de la liste entière ----------------------- */

test('la liste entière se supprime en une seule requête', async () => {
  const ctx = setup();
  const { server } = createApp({ config: ctx.config, store: ctx.store, logger: silentLogger, startWorker: false });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const register = await fetch(`${base}/api/auth/register`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'clear@exemple.test', password: 'motdepasse-solide' }),
    });
    const cookie = register.headers.getSetCookie()[0].split(';')[0];
    const owner = ctx.store.listUsers().find((item) => item.email === 'clear@exemple.test');

    const lines = [8000, 8001, 8002, 8003].map((port) =>
      `uti1lisateurfictif:motdepassefictif-country-US@us-east.gw.rayobyte.com:${port}`);
    const parsed = parseProxyImport(lines.join('\n'));
    ctx.store.insertProxies(owner.id, parsed.entries.map((entry) =>
      proxyRow(entry, ctx.config.secretKey, randomUUID(), entry.host)));
    ctx.store.saveProxyState(owner.id, { enabled: true, rotation: 'random', disableAfter: 5 });
    assert.equal(ctx.store.listProxies(owner.id).length, 4);

    const response = await fetch(`${base}/api/proxies?id=all`, { method: 'DELETE', headers: { cookie } });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.removed, 4);
    assert.match(body.message, /liste est vide/i);
    assert.equal(ctx.store.listProxies(owner.id).length, 0);

    // Les préférences survivent, le curseur est remis à zéro.
    const state = ctx.store.getProxyState(owner.id);
    assert.equal(state.rotation, 'random');
    assert.equal(state.disableAfter, 5);
    assert.equal(state.cursor, 0);
    assert.equal(state.lastProxyId, null);
  } finally {
    server.close();
    ctx.clean();
  }
});

/* --------------------------- lien en bio Instagram -------------------------- */

test('le redirecteur de lien en bio Instagram est décodé', () => {
  assert.equal(
    unwrapRedirectUrl('https://l.instagram.com/?u=https%3A%2F%2Fonlyfans.com%2Fuser&e=ATM'),
    'https://onlyfans.com/user',
  );
  assert.equal(
    unwrapRedirectUrl('https://www.instagram.com/l.php?u=https%3A%2F%2Fboutique.exemple.fr%2Fp%3Futm%3Dig'),
    'https://boutique.exemple.fr/p?utm=ig',
  );
  // Une URL normale n'est jamais altérée.
  assert.equal(unwrapRedirectUrl('https://boutique.exemple.fr/produit'), 'https://boutique.exemple.fr/produit');
  assert.equal(unwrapRedirectUrl('https://www.instagram.com/p/C123/'), 'https://www.instagram.com/p/C123/');
  assert.equal(unwrapRedirectUrl(''), '');
});

test('le lien en bio passe devant les boutons d’action du profil', async () => {
  const { JSDOM } = await import('jsdom');
  // Profil type : lien en bio court, boutons gros et centrés.
  const dom = new JSDOM(`<html><body><main>
    <div role="button" tabindex="0" onclick="go()"><span>shop</span></div>
    <button>S'abonner</button>
    <button>Message</button>
    <a href="/p/C123/">Voir la publication</a>
  </main></body></html>`, { pretendToBeVisual: true });
  dom.window.HTMLElement.prototype.getBoundingClientRect = () =>
    ({ width: 140, height: 30, top: 10, left: 10, right: 150, bottom: 40 });
  const previous = { window: globalThis.window, document: globalThis.document };
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  try {
    const candidates = clickableCollectorSource()({
      selector: 'a[href], [role="link"], button, [role="button"], summary',
      expected: '',
    });
    assert.ok(candidates.length >= 3);
    assert.equal(candidates[0].label, 'shop', `premier candidat : « ${candidates[0].label} »`);
    // Le libellé explicite l'emporte toujours, boutons d'action compris.
    const labelled = clickableCollectorSource()({
      selector: 'a[href], [role="link"], button, [role="button"], summary',
      expected: "s'abonner",
    });
    assert.equal(labelled.length, 1);
    assert.equal(labelled[0].label, "S'abonner");
  } finally {
    globalThis.window = previous.window;
    globalThis.document = previous.document;
  }
});

test('un bouton d’action ne prend jamais la place d’un lien de destination', async () => {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM(`<html><body><main>
    <a href="/p/C123/">Voir la publication</a>
    <button>S'abonner</button>
  </main></body></html>`, { pretendToBeVisual: true });
  dom.window.HTMLElement.prototype.getBoundingClientRect = () =>
    ({ width: 300, height: 60, top: 10, left: 10, right: 310, bottom: 70 });
  const previous = { window: globalThis.window, document: globalThis.document };
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  try {
    const [first] = clickableCollectorSource()({
      selector: 'a[href], [role="link"], button, [role="button"], summary',
      expected: '',
    });
    // Le bouton est plus gros : la surface ne doit pas décider.
    assert.equal(first.label, 'Voir la publication', `premier candidat : « ${first.label} »`);
  } finally {
    globalThis.window = previous.window;
    globalThis.document = previous.document;
  }
});
