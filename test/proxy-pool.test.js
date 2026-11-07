import test from 'node:test';
import assert from 'node:assert/strict';

// Le fichier partagé est un script classique (UMD) : il expose globalThis.InstaVAUtils.
await import('../extension/bot-utils.js');
const utils = globalThis.InstaVAUtils;

// Identifiants explicitement factices : aucun secret réel n'apparaît dans ce fichier,
// et le scan de secrets ne doit pas confondre « exempledidentifiant » avec un vrai mot de passe.
const FAKE_USER = 'exempledidentifiant';
const FAKE_PASS = 'valeurdedemonstration';

test('parseProxyLine accepts the four Webshare layouts', () => {
  const options = { defaultUsername: FAKE_USER, defaultPassword: FAKE_PASS };
  const samples = [
    [`proxy1.webshare.io:8000:${FAKE_USER}:${FAKE_PASS}`, 'proxy1.webshare.io', 8000, FAKE_USER, FAKE_PASS, 'http'],
    [`198.51.100.10:51234:${FAKE_USER}:${FAKE_PASS}`, '198.51.100.10', 51234, FAKE_USER, FAKE_PASS, 'http'],
    [`${FAKE_USER}:${FAKE_PASS}@203.0.113.9:9000`, '203.0.113.9', 9000, FAKE_USER, FAKE_PASS, 'http'],
    [`socks5://${FAKE_USER}:${FAKE_PASS}@proxy9.webshare.io:10080`, 'proxy9.webshare.io', 10080, FAKE_USER, FAKE_PASS, 'socks5'],
  ];
  for (const [line, host, port, username, password, scheme] of samples) {
    const parsed = utils.parseProxyLine(line, options);
    assert.equal(parsed.ok, true, `${line} doit être accepté (${parsed.message || ''})`);
    assert.equal(parsed.value.host, host);
    assert.equal(parsed.value.port, port);
    assert.equal(parsed.value.username, username);
    assert.equal(parsed.value.password, password);
    assert.equal(parsed.value.scheme, scheme);
  }
});

test('parseProxyLine accepts host:port with shared credentials', () => {
  const parsed = utils.parseProxyLine('proxy3.webshare.io:8011', { defaultUsername: FAKE_USER, defaultPassword: FAKE_PASS });
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.value, { scheme: 'http', host: 'proxy3.webshare.io', port: 8011, username: FAKE_USER, password: FAKE_PASS });
});

test('parseProxyLine supports passwords containing colons', () => {
  const parsed = utils.parseProxyLine(`proxy4.webshare.io:8012:${FAKE_USER}:pa:ss:word`);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.value.password, 'pa:ss:word');
});

test('parseProxyLine rejects local, private and malformed endpoints', () => {
  const rejected = [
    'localhost:8080:exempledidentifiant:valeurdedemonstration',
    '127.0.0.1:8080:exempledidentifiant:valeurdedemonstration',
    '10.1.2.3:8080:exempledidentifiant:valeurdedemonstration',
    '192.168.1.20:8080:exempledidentifiant:valeurdedemonstration',
    '[2001:db8::1]:8080:exempledidentifiant:valeurdedemonstration',
    'ftp://proxy.webshare.io:8080:exempledidentifiant:valeurdedemonstration',
    'proxy.webshare.io:exempledidentifiant:valeurdedemonstration',
    'proxy.webshare.io:8000:user',
    'proxy.webshare.io:0:exempledidentifiant:valeurdedemonstration',
    'proxy.webshare.io:8000:exempledidentifiant:valeurdedemonstration@elsewhere:1:u:p',
    '',
    '   ',
  ];
  for (const line of rejected) {
    assert.equal(utils.parseProxyLine(line).ok, false, `${line} doit être refusé`);
  }
});

test('parseProxyLines keeps order, skips comments and reports invalid lines', () => {
  const { entries, errors } = utils.parseProxyLines([
    '# export Webshare',
    'proxy1.webshare.io:8000:exempledidentifiant:valeurdedemonstration',
    '',
    'localhost:8000:exempledidentifiant:valeurdedemonstration',
    'proxy2.webshare.io:8001:exempledidentifiant:valeurdedemonstration',
    'proxy1.webshare.io:8000:exempledidentifiant:valeurdedemonstration',
  ].join('\n'));

  assert.equal(entries.length, 2);
  assert.equal(entries[0].host, 'proxy1.webshare.io');
  assert.equal(entries[1].host, 'proxy2.webshare.io');
  assert.equal(errors.length, 1);
  assert.equal(errors[0].line, 4);
});

test('validateProxyEntry normalizes hosts and schemes', () => {
  const parsed = utils.validateProxyEntry({ host: ' Proxy.Example.NET. ', port: '8080', scheme: 'HTTPS', username: FAKE_USER, password: FAKE_PASS });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.value.host, 'proxy.example.net');
  assert.equal(parsed.value.scheme, 'https');
  assert.equal(parsed.value.port, 8080);

  assert.equal(utils.validateProxyEntry({ host: 'proxy.example.net', port: '8080', scheme: 'ftp', username: FAKE_USER, password: FAKE_PASS }).ok, false);
  assert.equal(utils.validateProxyEntry({ host: 'proxy.example.net', port: '8080', username: '', password: FAKE_PASS }).ok, false);
  assert.equal(utils.validateProxyEntry({ host: 'proxy.example.net', port: '8080', username: FAKE_USER, password: '' }).ok, false);
});

test('round-robin rotates through every enabled proxy and skips disabled ones', () => {
  const proxies = [
    { id: 'a', host: 'a.example.net', port: 1, username: FAKE_USER, password: FAKE_PASS, enabled: true },
    { id: 'b', host: 'b.example.net', port: 2, username: FAKE_USER, password: FAKE_PASS, enabled: false },
    { id: 'c', host: 'c.example.net', port: 3, username: FAKE_USER, password: FAKE_PASS, enabled: true },
  ];
  const first = utils.pickProxy(proxies, { mode: 'round-robin', cursor: 0 });
  assert.equal(first.proxy.id, 'a');
  assert.equal(first.cursor, 1);
  const second = utils.pickProxy(proxies, { mode: 'round-robin', cursor: first.cursor });
  assert.equal(second.proxy.id, 'c');
  assert.equal(second.cursor, 0);
  const third = utils.pickProxy(proxies, { mode: 'round-robin', cursor: second.cursor });
  assert.equal(third.proxy.id, 'a');
});

test('random selection stays inside the enabled list', () => {
  const proxies = Array.from({ length: 5 }, (_, index) => ({
    id: `p${index}`, host: `p${index}.example.net`, port: 8000 + index, username: FAKE_USER, password: FAKE_PASS, enabled: index !== 2,
  }));
  const seen = new Set();
  for (const value of [0, 0.26, 0.51, 0.99]) {
    const picked = utils.pickProxy(proxies, { mode: 'random' }, () => value);
    assert.ok(picked.proxy);
    assert.notEqual(picked.proxy.id, 'p2');
    seen.add(picked.proxy.id);
  }
  assert.ok(seen.size >= 3);
  assert.equal(utils.pickProxy([], { mode: 'random' }).proxy, null);
});

test('proxy counters accumulate and consecutive failures disable the proxy', () => {
  let proxy = { id: 'a', host: 'a.example.net', port: 1, username: FAKE_USER, password: FAKE_PASS, enabled: true };

  proxy = utils.applyProxyOutcome(proxy, { status: 'success' }, { now: '2026-01-01T00:00:00.000Z' });
  assert.equal(proxy.uses, 1);
  assert.equal(proxy.successes, 1);
  assert.equal(proxy.consecutiveFailures, 0);

  proxy = utils.applyProxyOutcome(proxy, { status: 'failed', error: 'net::ERR_PROXY_CONNECTION_FAILED' }, {});
  assert.equal(proxy.failures, 1);
  assert.equal(proxy.consecutiveFailures, 1);
  assert.equal(proxy.enabled, true);
  assert.match(proxy.lastError, /ERR_PROXY/);

  proxy = utils.applyProxyOutcome(proxy, { status: 'failed', error: 'boom' }, {});
  proxy = utils.applyProxyOutcome(proxy, { status: 'failed', error: 'boom' }, {});
  assert.equal(proxy.consecutiveFailures, 3);
  assert.equal(proxy.enabled, false);
  assert.match(proxy.disabledReason, /3 échecs/);

  // Un cycle ignoré (clic non effectué) ne touche à aucun compteur.
  const untouched = utils.applyProxyOutcome(proxy, { status: 'skipped', active: false }, {});
  assert.equal(untouched.uses, proxy.uses);
});

test('sanitizeSavedProxy drops unusable entries and clamps counters', () => {
  const valid = utils.sanitizeSavedProxy({
    id: 'p1', name: 'Webshare A', scheme: 'http', host: 'proxy.webshare.io', port: 8000,
    username: FAKE_USER, password: FAKE_PASS, enabled: true, uses: -4, failures: 2.7, consecutiveFailures: 'x',
  });
  assert.equal(valid.host, 'proxy.webshare.io');
  assert.equal(valid.uses, 0);
  assert.equal(valid.failures, 2);
  assert.equal(valid.consecutiveFailures, 0);
  assert.equal(valid.enabled, true);

  assert.equal(utils.sanitizeSavedProxy({ id: 'p2', host: 'localhost', port: 1, username: FAKE_USER, password: FAKE_PASS }), null);
  assert.equal(utils.sanitizeSavedProxy({ host: 'proxy.webshare.io', port: 8000, username: FAKE_USER, password: FAKE_PASS }), null);
  assert.equal(utils.sanitizeSavedProxy(null), null);
});

test('proxy credentials stay exportable and exportable line round-trips', () => {
  const proxy = { name: 'A', scheme: 'http', host: 'proxy.webshare.io', port: 8000, username: FAKE_USER, password: FAKE_PASS };
  assert.equal(utils.proxyCredentialsLine(proxy), `proxy.webshare.io:8000:${FAKE_USER}:${FAKE_PASS}`);
  assert.equal(utils.proxyEndpoint(proxy), 'http://proxy.webshare.io:8000');
  assert.equal(utils.maskUsername('exempledidentifiant'), 'exe…');
  assert.equal(utils.maskUsername('ab'), '••');
});

test('proxy settings default to round-robin and sanitize unknown values', () => {
  assert.deepEqual(utils.sanitizeProxySettings(undefined), { useProxy: true, mode: 'round-robin', cursor: 0, autoDisable: true });
  assert.equal(utils.sanitizeProxySettings({ mode: 'nonsense' }).mode, 'round-robin');
  assert.equal(utils.sanitizeProxySettings({ mode: 'random', useProxy: false }).mode, 'random');
  assert.equal(utils.sanitizeProxySettings({ cursor: -2 }).cursor, 0);
});

test('OCR worker options point to the bundled vendor assets', () => {
  const options = utils.buildOcrWorkerOptions('chrome-extension://abc/vendor/');
  assert.equal(options.workerPath, 'chrome-extension://abc/vendor/worker.min.js');
  assert.equal(options.corePath, 'chrome-extension://abc/vendor/');
  assert.equal(options.langPath, 'chrome-extension://abc/vendor/lang-data');
  assert.equal(options.workerBlobURL, false, 'la CSP MV3 interdit les workers blob:');
  assert.equal(options.cacheMethod, 'write');
  assert.equal(options.legacyCore, false);

  const relative = utils.buildOcrWorkerOptions('vendor');
  assert.equal(relative.corePath, 'vendor/');
  assert.equal(relative.workerPath, 'vendor/worker.min.js');
});

test('OCR language falls back to the bundled default', () => {
  assert.equal(utils.normalizeOcrLanguage('eng'), 'eng');
  assert.equal(utils.normalizeOcrLanguage('FRA'), 'fra');
  assert.equal(utils.normalizeOcrLanguage('deu'), 'fra+eng');
  assert.equal(utils.normalizeOcrLanguage(null), 'fra+eng');
});
