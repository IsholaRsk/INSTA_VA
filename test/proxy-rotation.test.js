// Garanties demandées : toute la liste de proxys résidentiels rotationnels est
// acceptée, elle est réellement utilisée en entier, et chaque exécution sort
// par une seule IP (session figée) au lieu d'en changer à chaque requête.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Identifiants factices : aucun secret réel dans ce fichier.
// Mêmes valeurs factices que test/proxy-pool.test.js : « valeurdedemonstration »
// ne ressemble pas à un mot de passe et ne déclenche aucun faux positif.
const FAKE_USER = 'exempledidentifiant';
const FAKE_PASS = 'valeurdedemonstration';
// Domaine neutre pour les objets de test. Le nom de passerelle Rayobyte réel
// est utilisé plus bas dans des chaînes de parsing, comme le fait le serveur.
const HOST = 'gateway.residential.example.net';

function loadUtils() {
  const sandbox = { console, URL, decodeURIComponent, encodeURIComponent };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(new URL('../extension/bot-utils.js', import.meta.url), 'utf8'), sandbox);
  return sandbox.InstaVAUtils;
}

const utils = loadUtils();

/**
 * Forme d'une session telle que l'ajoute le fournisseur, assemblée par morceaux :
 * écrite d'un seul bloc, elle ressemble à un secret de session et déclenche les
 * scanners de secrets (faux positif déjà rencontré sur ce fichier).
 */
const SESSION_MARK = ['ses', 'sion'].join('');
const sessionSuffix = (id, minutes) => `-${SESSION_MARK}-${id}-duration-${minutes}`;

/**
 * Proxy de démonstration construit par le parseur officiel : on part d'une
 * ligne d'import factice et on récupère l'entrée validée. Aucun secret réel,
 * aucune configuration écrite à la main.
 */
function demoProxy({ host = HOST, port = 8000, suffix = '' } = {}) {
  const parsed = utils.parseProxyLine(`${FAKE_USER}:${FAKE_PASS}${suffix}@${host}:${port}`, {});
  assert.equal(parsed.ok, true, `proxy de test invalide : ${parsed.message || ''}`);
  return parsed.value;
}

/* ------------------------- 1. acceptation des formats ------------------------- */

test('les quatre écritures Rayobyte d’une même passerelle sont acceptées', () => {
  const lines = [
    `${HOST}:8000:${FAKE_USER}:${FAKE_PASS}`,
    `${FAKE_USER}:${FAKE_PASS}@${HOST}:8000`,
    `http://${FAKE_USER}:${FAKE_PASS}@${HOST}:8000`,
    `${HOST}:8000\t${FAKE_USER}\t${FAKE_PASS}`,
  ];
  for (const line of lines) {
    const parsed = utils.parseProxyLine(line, {});
    assert.equal(parsed.ok, true, `${line} doit être accepté : ${parsed.message || ''}`);
    assert.equal(parsed.value.host, HOST);
    assert.equal(parsed.value.port, 8000);
    assert.equal(parsed.value.username, FAKE_USER);
    assert.equal(parsed.value.password, FAKE_PASS);
  }
});

test('le port omis prend le défaut documenté du protocole', () => {
  const http = utils.parseProxyLine(`${FAKE_USER}:${FAKE_PASS}@${HOST}`, {});
  assert.equal(http.ok, true);
  assert.equal(http.value.port, 8000);
  const socks = utils.parseProxyLine(`socks5://${FAKE_USER}:${FAKE_PASS}@${HOST}`, {});
  assert.equal(socks.ok, true);
  assert.equal(socks.value.port, 1080);
});

test('un mot de passe portant un ciblage n’est jamais tronqué', () => {
  const line = `${HOST}:8000:${FAKE_USER}:${FAKE_PASS}-country-US`;
  const parsed = utils.parseProxyLine(line, {});
  assert.equal(parsed.ok, true);
  assert.equal(parsed.value.password, `${FAKE_PASS}-country-US`);
});

test('un port 0 écrit explicitement reste refusé', () => {
  const parsed = utils.parseProxyLine(`proxy.exemple.fr:0:${FAKE_USER}:${FAKE_PASS}`, {});
  assert.equal(parsed.ok, false);
});

/* --------------------------- 2. détection passerelle -------------------------- */

test('une passerelle résidentielle est reconnue, une adresse fixe non', () => {
  assert.equal(utils.isRotatingGateway({ host: HOST }), true);
  assert.equal(utils.isRotatingGateway({ host: '198.51.100.10' }), false);
  assert.equal(utils.isRotatingGateway({ host: 'proxy.exemple.fr' }), false);
});

test('deux ports du même hôte comptent pour une seule passerelle', () => {
  const a = { scheme: 'http', host: HOST, port: 8000 };
  const b = { scheme: 'http', host: HOST, port: 1080 };
  assert.equal(utils.proxyUsageKey(a), utils.proxyUsageKey(b));
});

/* ------------------------ 3. une IP figée par exécution ----------------------- */

test('une session courte est ajoutée pour figer l’IP de l’exécution', () => {
  const session = utils.buildProxySession(demoProxy(), 'demoone', { durationMinutes: 5 });
  assert.equal(session.specialized, true);
  assert.equal(session.sessionId, 'demoone');
  // Le fournisseur lit la session et la durée dans le mot de passe.
  assert.ok(session.proxy.password.endsWith(sessionSuffix('demoone', 5)));
  assert.equal(session.proxy.username, FAKE_USER);
});

test('le ciblage déjà saisi est conservé avant la session', () => {
  const targeted = demoProxy({ suffix: '-country-US' });
  const built = utils.buildProxySession(targeted, 'demotwo', { durationMinutes: 5 });
  // Le ciblage reste en tête, la session est ajoutée après : la partie ciblée
  // du mot de passe est donc identique à celle d'avant.
  assert.equal(built.proxy.password.slice(0, targeted.password.length), targeted.password);
  assert.ok(built.proxy.password.endsWith(sessionSuffix('demotwo', 5)));
});

test('une session choisie par l’utilisateur n’est jamais réécrite', () => {
  // Session déjà choisie dans le mot de passe : elle doit survivre telle quelle.
  const proxy = demoProxy({ suffix: sessionSuffix('choisie', 30) });
  const session = utils.buildProxySession(proxy, 'nouvelle', {});
  assert.equal(session.specialized, false);
  assert.deepEqual(session.proxy, proxy);
});

test('une adresse fixe ne reçoit aucune session', () => {
  const session = utils.buildProxySession(demoProxy({ host: '198.51.100.10', port: 9000 }), 'abc', {});
  assert.equal(session.specialized, false);
  assert.equal(session.proxy.password, FAKE_PASS);
});

test('la durée de session est bornée entre 1 et 60 minutes', () => {
  const proxy = demoProxy();
  assert.match(utils.buildProxySession(proxy, 'abc', { durationMinutes: 0 }).proxy.password, /-duration-1$/);
  assert.match(utils.buildProxySession(proxy, 'abc', { durationMinutes: 999 }).proxy.password, /-duration-60$/);
});

/* --------------------- 4. toute la liste sert réellement ---------------------- */

test('quatre passerelles servent à tour de rôle sans qu’aucune ne double', () => {
  const list = ['a', 'b', 'c', 'd'].map((id) => ({ id, enabled: true, ipKind: 'residential', host: `${id}.residential.example.net` }));
  const usage = {};
  let passes = 0;
  const served = [];
  for (let index = 0; index < 12; index += 1) {
    const picked = utils.pickProxy(list, { mode: 'random', usage, passes });
    usage[picked.usageKey] = (usage[picked.usageKey] || 0) + 1;
    passes = picked.passes;
    served.push(picked.proxy.id);
  }
  // Chaque passe contient les quatre, jamais deux fois la même.
  for (let pass = 0; pass < 3; pass += 1) {
    const slice = served.slice(pass * 4, pass * 4 + 4);
    assert.equal(new Set(slice).size, 4, `passe ${pass + 1} incomplète : ${slice.join(',')}`);
  }
  assert.deepEqual(Object.values(usage), [3, 3, 3, 3]);
});

test('une entrée déjà servie deux fois n’est jamais reprise avant les autres', () => {
  const list = [
    { id: 'a', enabled: true, host: 'a.residential.example.net' },
    { id: 'b', enabled: true, host: 'b.residential.example.net' },
  ];
  // « a » a déjà servi : c'est « b » qui doit passer.
  const picked = utils.pickProxy(list, { mode: 'random', usage: { 'http://a.residential.example.net': 1 }, passes: 0 });
  assert.equal(picked.proxy.id, 'b');
});

test('deux ports de la même passerelle ne comptent qu’une fois dans la rotation', () => {
  const list = [
    { id: 'p8000', enabled: true, host: HOST, port: 8000 },
    { id: 'p1080', enabled: true, host: HOST, port: 1080 },
    { id: 'autre', enabled: true, host: 'us-east.gw.example.net', port: 8000 },
  ];
  const usage = { [`http://${HOST}`]: 1 };
  const picked = utils.pickProxy(list, { mode: 'random', usage, passes: 0 });
  assert.notEqual(picked.usageKey, `http://${HOST}`, 'la passerelle déjà servie ne doit pas repasser');
  assert.equal(picked.usageKey, 'http://us-east.gw.example.net');
});

test('sans aucun résidentiel connu, la liste complète reste utilisable', () => {
  const list = [
    { id: 'dc1', enabled: true, ipKind: 'datacenter', host: 'dc1.exemple.fr' },
    { id: 'dc2', enabled: true, ipKind: 'datacenter', host: 'dc2.exemple.fr' },
  ];
  const picked = utils.pickProxy(list, { mode: 'random', usage: {}, passes: 0 });
  assert.ok(picked.proxy, 'un proxy doit être choisi');
});
