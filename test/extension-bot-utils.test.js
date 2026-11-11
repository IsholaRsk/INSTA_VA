// Vérifie les règles portées depuis le serveur dans l'extension :
// blocage 1020 vs vérification, décodage du lien en bio, classement du clic,
// nature d'IP et priorité des proxys résidentiels.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

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

test('une page 1020 est reconnue comme un blocage, pas comme une vérification', () => {
  const gate = utils.detectPageGate({
    title: 'Sorry, you have been blocked',
    html: '<html><body>You are unable to access this site. Error code: 1020</body></html>',
  });
  assert.equal(gate.kind, 'blocked');
  assert.match(gate.reason, /1020|titre/i);
});

test('une vérification Cloudflare est distinguée du blocage', () => {
  const gate = utils.detectPageGate({ title: 'Just a moment...', html: '<div id="challenge-stage"></div>' });
  assert.equal(gate.kind, 'cloudflare');
  assert.notEqual(gate.kind, 'blocked');
});

test('une page Instagram normale ne déclenche aucune alerte', () => {
  assert.equal(utils.detectPageGate({
    title: 'Instagram',
    html: '<html><head><title>Instagram</title></head><body><section><a href="/shop">shop</a></section></body></html>',
  }), null);
});

test('le lien en bio masqué derrière l.instagram.com est décodé', () => {
  assert.equal(
    utils.unwrapRedirectUrl('https://l.instagram.com/?u=https%3A%2F%2Fonlyfans.com%2Fuser&e=x'),
    'https://onlyfans.com/user',
  );
  assert.equal(
    utils.unwrapRedirectUrl('https://www.instagram.com/l.php?u=https%3A%2F%2Fexemple.fr%2Fboutique'),
    'https://exemple.fr/boutique',
  );
});

test('une URL directe traverse le décodage sans être modifiée', () => {
  const direct = 'https://www.instagram.com/shop.brand/';
  assert.equal(utils.unwrapRedirectUrl(direct), direct);
});

test('un bouton d’action passe derrière un lien de bio court', () => {
  const follow = utils.scoreClickable({ text: 'S’abonner', href: '', area: 9020, kind: 'link', isControl: true });
  const bio = utils.scoreClickable({ text: 'shop', href: 'https://instagram.com/shop.brand', area: 5400, kind: 'link' });
  assert.equal(follow.actionButton, true);
  assert.equal(bio.bioLink, true);
  assert.ok(bio.score > follow.score, `bio ${bio.score} devrait dépasser action ${follow.score}`);
});

test('« Message », « Suivre » et « Partager » ne sont jamais pris pour la bio', () => {
  for (const text of ['Message', 'Suivre', 'Partager', 'S’abonner', "S'abonner"]) {
    const clicked = utils.scoreClickable({ text, href: '', area: 8000, kind: 'link' });
    assert.equal(utils.looksLikeBioLinkText(text), false, `${text} ne doit pas ressembler à un lien de bio`);
    assert.equal(clicked.actionButton, true, `${text} doit être classé comme action`);
  }
});

test('une adresse d’hébergeur est classée datacenter, un FAI résidentiel', () => {
  assert.equal(utils.classifyIp({ asn: 16276, org: 'OVH SAS' }).kind, 'datacenter');
  assert.equal(utils.classifyIp({ asn: null, org: 'Hetzner Online GmbH' }).kind, 'datacenter');
  assert.equal(utils.classifyIp({ asn: 12322, org: 'Free SAS' }).kind, 'residential');
  assert.equal(utils.classifyIp({}).kind, 'unknown');
});

test('un proxy résidentiel est préféré aux datacenters', () => {
  const pool = [
    { id: 'dc1', ipKind: 'datacenter' },
    { id: 'res1', ipKind: 'residential' },
    { id: 'new1', ipKind: '' },
  ];
  const picked = utils.pickProxy(pool, { random: () => 0 });
  assert.ok(picked, 'un proxy doit être choisi');
  assert.notEqual(picked.id, 'dc1', 'le datacenter ne doit pas passer devant le résidentiel');
});

test('sans résidentiel connu, la liste complète reste utilisable', () => {
  const pool = [{ id: 'dc1', ipKind: 'datacenter' }, { id: 'dc2', ipKind: 'datacenter' }];
  assert.ok(utils.pickProxy(pool, { random: () => 0 }));
});

test('la nature d’IP est conservée à l’enregistrement et les valeurs inconnues écartées', () => {
  const base = { id: 'a', host: 'proxy.exemple.fr', port: 8000, username: 'identifiantfictif', password: 'motdepassefictif' };
  assert.equal(utils.sanitizeSavedProxy({ ...base, ipKind: 'residential' }).ipKind, 'residential');
  assert.equal(utils.sanitizeSavedProxy({ ...base, ipKind: 'datacenter' }).ipKind, 'datacenter');
  assert.equal(utils.sanitizeSavedProxy({ ...base, ipKind: 'bidon' }).ipKind, '');
});
