import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

// Les scripts type="module" ne s'exécutent pas sous jsdom : on vérifie le câblage statique
// (identifiants présents, aucune référence à l'ancienne API mono-proxy, appels cohérents).
test('interface : la section proxys expose l’import en masse et la rotation', async () => {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const dom = new JSDOM(html);
  const { document } = dom.window;

  for (const id of ['proxy-text', 'proxy-scheme', 'proxy-username', 'proxy-password', 'proxy-rotation', 'save-proxy', 'test-proxies', 'remove-proxy', 'proxy-enabled', 'proxy-list', 'proxy-summary', 'proxy-badge']) {
    assert.ok(document.getElementById(id), `#${id} doit exister`);
  }
  const textarea = document.getElementById('proxy-text');
  assert.equal(textarea.tagName, 'TEXTAREA');
  assert.match(textarea.getAttribute('placeholder'), /hôte:port:identifiant:motdepasse/);

  // Plus aucun champ mono-proxy.
  for (const removed of ['proxy-host', 'proxy-port', 'proxy-form-scheme']) {
    assert.equal(document.getElementById(removed), null, `#${removed} doit avoir disparu`);
  }
  // La mention honnête sur les proxys datacenter est présente.
  assert.match(document.querySelector('.proxy-copy').textContent, /datacenter/);
});

test('interface : le client parle uniquement à /api/proxies', async () => {
  const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.ok(source.includes("'/api/proxies'"), 'liste et import');
  assert.ok(source.includes('/api/proxies/test'), 'route de test');
  assert.ok(source.includes("id=disabled"), 'purge des désactivés');
  assert.ok(!/['"`]\/api\/proxy['"`]/.test(source), 'l’ancienne route /api/proxy ne doit plus être appelée');
  assert.ok(!source.includes('proxyConfigured'), 'état mono-proxy supprimé');
});

test('proxys : les erreurs réseau sont traduites, jamais renvoyées en anglais', async () => {
  const { friendlyProxyError } = await import('../server/proxies.js');
  assert.equal(friendlyProxyError(new Error('read ECONNRESET')), 'Le proxy a coupé la connexion.');
  assert.equal(friendlyProxyError(new Error('connect ECONNREFUSED 1.2.3.4:80')), 'Connexion au proxy impossible (refusée).');
  assert.equal(friendlyProxyError(new Error('getaddrinfo ENOTFOUND proxy')), 'Hôte du proxy introuvable.');
  assert.equal(friendlyProxyError(new Error('socket hang up')), 'Le proxy a coupé la connexion.');
  assert.match(friendlyProxyError(new Error('')), /n’a pas répondu/);
});
