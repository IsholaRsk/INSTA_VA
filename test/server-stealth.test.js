import test from 'node:test';
import assert from 'node:assert/strict';

import { detectChallengeSnapshot, challengeDebugInfo } from '../server/challenge.js';
import { buildUserAgent, clientHints, contextProfile, stealthInitScript, STEALTH_ARGS } from '../server/stealth.js';
import { ChallengeError } from '../server/browser.js';
import { friendlyCycleError } from '../server/worker.js';

test('détecte les pages de vérification Cloudflare', () => {
  const cases = [
    { title: 'Just a moment...' },
    { title: 'Un instant…' },
    { title: 'Attention Required! | Cloudflare' },
    { title: 'Accès refusé' },
    { html: '<html><script>window._cf_chl_opt = {}</script></html>' },
    { html: '<div id="cf-browser-verification"></div>' },
    { html: '<iframe src="https://challenges.cloudflare.com/turnstile/v0/api.js"></iframe>' },
    { selectors: '#challenge-running' },
    { url: 'https://exemple.fr/cdn-cgi/challenge-platform/h/b/orchestrate/jsch/v1' },
  ];
  for (const snapshot of cases) {
    const result = detectChallengeSnapshot(snapshot);
    assert.ok(result, `non détecté : ${JSON.stringify(snapshot)}`);
    assert.equal(result.kind, 'cloudflare');
    assert.ok(result.reason.length > 0);
  }
});

test('ne confond pas une page normale ou une erreur serveur avec un challenge', () => {
  // Page réelle : aucun marqueur.
  assert.equal(detectChallengeSnapshot({ title: 'Boutique — Accueil', html: '<a href="/x">Acheter</a>' }), null);
  // Erreur 5xx Cloudflare : ce n'est pas un challenge, il ne sert à rien d'attendre.
  assert.equal(detectChallengeSnapshot({ title: 'Cloudflare 522', html: '<div id="cf-error-details">Timeout</div>' }), null);
  assert.equal(detectChallengeSnapshot({ title: 'Erreur 500', html: '<body>Internal Server Error</body>' }), null);
  assert.equal(detectChallengeSnapshot({}), null);
});

test('le résumé technique reste court et sans secret', () => {
  const info = challengeDebugInfo({ title: 'Just a moment...', url: 'https://exemple.fr/x?token=abc' });
  assert.match(info, /Just a moment/);
  assert.ok(info.length <= 220);
});

test('le User-Agent annonce la version réelle du moteur', () => {
  // L'ancien code annonçait Chrome/131 avec un moteur 158 : signal immédiat.
  const ua = buildUserAgent('158.0.8127.18');
  assert.match(ua, /Chrome\/158\.0\.8127\.18/);
  assert.ok(!ua.includes('131'));
  assert.ok(!/HeadlessChrome/i.test(ua));
  assert.match(buildUserAgent('158.0.8127.18', 'windows'), /Windows NT 10\.0/);
  // Version inconnue : on retombe sur une valeur plausible, jamais vide.
  assert.match(buildUserAgent(''), /Chrome\/\d+/);
});

test('les client hints sont cohérents avec le User-Agent', () => {
  const hints = clientHints('158.0.8127.18');
  assert.match(hints['sec-ch-ua'], /v="158"/);
  assert.equal(hints['sec-ch-ua-mobile'], '?0');
  assert.equal(hints['sec-ch-ua-platform'], '"Linux"');
  assert.equal(clientHints('158.0.8127.18', 'windows')['sec-ch-ua-platform'], '"Windows"');
});

test('le profil de contexte imite un bureau réel', () => {
  const profile = contextProfile('158.0.8127.18');
  assert.equal(profile.isMobile, false);
  assert.equal(profile.hasTouch, false);
  assert.equal(profile.locale, 'fr-FR');
  assert.ok(profile.viewport.width >= 1280 && profile.viewport.height >= 720);
  assert.match(profile.userAgent, /Chrome\/158/);
  assert.ok(profile.extraHTTPHeaders['sec-ch-ua']);
});

test('le script furtif neutralise navigator.webdriver', () => {
  const script = stealthInitScript();
  assert.match(script, /navigator, 'webdriver'/);
  // Volontairement minimal : aucune surcharge invérifiable ajoutée.
  assert.ok(script.length < 800, 'script court et lisible');
});

test('les options de lancement retirent le drapeau d’automatisation', () => {
  assert.ok(STEALTH_ARGS.includes('--disable-blink-features=AutomationControlled'));
});

test('un blocage Cloudflare produit un message actionnable', () => {
  const error = new ChallengeError({ kind: 'cloudflare', reason: 'titre « Just a moment... »' }, 403);
  const message = friendlyCycleError(error);
  assert.match(message, /Cloudflare/);
  assert.match(message, /HTTP 403/);
  assert.match(message, /proxy/i);
  // Ce n'est pas présenté comme un problème de libellé.
  assert.ok(!/libellé/i.test(message));
  // Les détails internes ne fuient pas.
  assert.ok(!message.includes('cf_chl') && !message.includes('/home/'));
});
