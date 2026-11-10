import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { openDatabase, SCHEMA_VERSION } from '../server/db.js';
import { createStore } from '../server/store.js';
import { loadConfig } from '../server/config.js';
import { parseProxyImport, proxyRow, nextProxy, attachSecretKey } from '../server/proxies.js';

function tempDir() {
  const dir = mkdtempSync(path.join(tmpdir(), 'instava-mig-'));
  return { dir, file: path.join(dir, 'm.sqlite'), clean: () => rmSync(dir, { recursive: true, force: true }) };
}

test('migration : une base neuve arrive directement au schéma courant', () => {
  const spot = tempDir();
  try {
    const db = openDatabase(spot.file);
    // La version augmente à chaque migration : on vérifie qu'elle est à jour.
    assert.equal(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value, String(SCHEMA_VERSION));
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name);
    assert.ok(tables.includes('proxies'));
    assert.ok(tables.includes('proxy_state'));
    assert.ok(!tables.includes('proxy_settings'), 'l’ancienne table ne doit plus exister');
    db.close();
  } finally { spot.clean(); }
});

test('migration : l’ancien proxy unique est repris dans la liste, sans perte', () => {
  const spot = tempDir();
  try {
    // Base v1 d'origine : proxy_settings + schéma 1.
    const legacy = openDatabase(spot.file);
    legacy.exec("INSERT INTO users (id, email, password_hash, role, created_at) VALUES ('u1', 'a@b.c', 'x', 'owner', '2026-01-01T00:00:00.000Z')");
    legacy.exec('DROP TABLE proxies');
    legacy.exec('DROP TABLE proxy_state');
    legacy.exec(`CREATE TABLE proxy_settings (user_id TEXT PRIMARY KEY, scheme TEXT NOT NULL, host TEXT NOT NULL,
      port INTEGER NOT NULL, username_masked TEXT NOT NULL, secret_box TEXT NOT NULL, updated_at TEXT NOT NULL)`);
    legacy.prepare('INSERT INTO proxy_settings VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('u1', 'http', 'ancien.exemple.fr', 8080, 'an••', 'boite-chiffree', '2026-01-01T00:00:00.000Z');
    legacy.prepare("UPDATE meta SET value = '1' WHERE key = 'schema_version'").run();
    legacy.close();

    const db = openDatabase(spot.file);
    // La version augmente à chaque migration : on vérifie qu'elle est à jour.
    assert.equal(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value, String(SCHEMA_VERSION));
    assert.equal(db.prepare("SELECT count(*) AS c FROM sqlite_master WHERE name = 'proxy_settings'").get().c, 0);

    const store = createStore(db);
    const list = store.listProxies('u1');
    assert.equal(list.length, 1);
    assert.equal(list[0].host, 'ancien.exemple.fr');
    assert.equal(list[0].port, 8080);
    assert.equal(list[0].enabled, true);
    // La rotation est activée pour que l'ancien comportement soit conservé.
    assert.equal(store.getProxyState('u1').enabled, true);
    db.close();
  } finally { spot.clean(); }
});

test('rotation aléatoire : jamais deux cycles de suite par le même proxy', async () => {
  const spot = tempDir();
  try {
    const config = loadConfig({ DATA_DIR: spot.dir, DATABASE_FILE: spot.file, PUBLIC_DIR: path.join(process.cwd(), 'public'), INSTAVA_SECRET_KEY: 'cle-de-test', PORT: '0' });
    const store = attachSecretKey(createStore(openDatabase(config.databaseFile)), config.secretKey);
    store.createUser({ email: 'rot@exemple.test', passwordHash: 'x', role: 'owner' });
    const userId = store.listUsers()[0].id;
    const parsed = parseProxyImport(['a', 'b', 'c', 'd'].map((name, index) => `${name}.exemple.fr:${8000 + index}:identifiantfictif:motdepassefictif`).join('\n'));
    store.insertProxies(userId, parsed.entries.map((entry, index) => proxyRow(entry, config.secretKey, randomUUID(), `P${index}`)));
    store.saveProxyState(userId, { enabled: true, rotation: 'random' });

    const sequence = [];
    for (let step = 0; step < 40; step += 1) sequence.push(nextProxy(store, userId).proxy.host);
    for (let index = 1; index < sequence.length; index += 1) {
      assert.notEqual(sequence[index], sequence[index - 1], `répétition au cycle ${index} : ${sequence.join(' ')}`);
    }
  } finally { spot.clean(); }
});
