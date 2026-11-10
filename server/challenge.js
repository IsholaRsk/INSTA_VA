/**
 * Détection des pages de blocage anti-bot (Cloudflare, Turnstile, DataDome…).
 *
 * Un cycle qui tombe sur une interception doit être signalé comme tel — pas
 * comme « libellé introuvable » — sinon l'utilisateur cherche un problème
 * dans sa cible alors que la page n'a jamais été servie.
 */

// Titres caractéristiques d'une interception Cloudflare.
const CHALLENGE_TITLES = [
  'just a moment',
  'attention required',
  'checking your browser',
  'un instant',
  'vérification de sécurité',
  'verification de securite',
  'access denied',
  'accès refusé',
  'acces refuse',
];

// Fragments présents dans le HTML d'une page de challenge.
const CHALLENGE_MARKERS = [
  'cf-browser-verification',
  'cf_chl_opt',
  'cf-challenge',
  'challenge-platform',
  'challenges.cloudflare.com',
  'cf-turnstile',
  '__cf_chl_jschl_tk__',
  'datadome',
  'px-captcha',
  'perimeterx',
  'captcha-delivery',
];

// Éléments visibles qui trahissent une page d'attente.
const CHALLENGE_SELECTORS = [
  '#challenge-form',
  '#challenge-running',
  '#cf-challenge-running',
  '.cf-browser-verification',
  'iframe[src*="challenges.cloudflare.com"]',
  'iframe[src*="captcha-delivery.com"]',
  '#px-captcha',
];

// Titres de la page de blocage pare-feu Cloudflare (erreur 1020 et proches).
// Ce n'est PAS un challenge : la page ne se résoudra jamais toute seule.
const BLOCK_TITLES = [
  'sorry, you have been blocked',
  'you have been blocked',
  'désolé, vous avez été bloqué',
  'desole, vous avez ete bloque',
  'access denied | cloudflare',
  'attention required! | cloudflare',
];

// Messages du corps de la page de blocage Cloudflare.
const BLOCK_MARKERS = [
  'error code: 1020',
  'error 1020',
  'you are unable to access',
  'cloudflare ray id',
  'performance & security by cloudflare',
];

/**
 * Le blocage pare-feu (erreur 1020, « Sorry, you have been blocked ») est
 * distinct d'un challenge : il n'y a rien à attendre, la décision est déjà
 * prise côté serveur. Confondre les deux fait attendre 15 s pour rien et
 * affiche « libellé introuvable » alors que la page n'a jamais été servie.
 * @param {{ title?: string, html?: string }} snapshot
 */
export function detectBlockedSnapshot({ title = '', html = '' } = {}) {
  const lowerTitle = String(title || '').toLocaleLowerCase('fr');
  const lowerHtml = String(html || '').toLocaleLowerCase('fr');
  const titleHit = BLOCK_TITLES.find((marker) => lowerTitle.includes(marker));
  if (titleHit) return { kind: 'blocked', reason: `titre « ${String(title).slice(0, 80)} »` };
  // Le code 1020 est sans ambiguïté ; les autres marqueurs exigent deux
  // indices concordants pour ne pas transformer une 5xx en blocage.
  if (lowerHtml.includes('error code: 1020') || lowerHtml.includes('error 1020')) {
    return { kind: 'blocked', reason: 'erreur 1020' };
  }
  const markerHits = BLOCK_MARKERS.filter((marker) => lowerHtml.includes(marker));
  if (markerHits.length >= 2 && lowerHtml.includes('blocked')) {
    return { kind: 'blocked', reason: `marqueurs ${markerHits.slice(0, 2).join(', ')}` };
  }
  return null;
}

/**
 * Analyse une page déjà chargée. Retourne `null` si la page est normale.
 * @param {{ title?: string, html?: string, url?: string, selectors?: string }} snapshot
 */
export function detectChallengeSnapshot({ title = '', html = '', url = '', selectors = '' } = {}) {
  const lowerTitle = String(title || '').toLocaleLowerCase('fr');
  const lowerHtml = String(html || '').toLocaleLowerCase('fr');
  const lowerUrl = String(url || '').toLocaleLowerCase('fr');

  const titleHit = CHALLENGE_TITLES.find((marker) => lowerTitle.includes(marker));
  const selectorHit = CHALLENGE_SELECTORS.find((marker) => String(selectors || '').includes(marker));
  const urlHit = lowerUrl.includes('/cdn-cgi/challenge-platform') || lowerUrl.includes('__cf_chl');

  // Volontairement absents : `cf-error-details` et `ray_id`, présents aussi sur
  // une simple page d'erreur 5xx. Un challenge se reconnaît à ses marqueurs propres.
  const htmlHit = CHALLENGE_MARKERS.find((marker) => lowerHtml.includes(marker));

  // Le blocage pare-feu est prioritaire : « Attention Required! » qualifie les
  // deux cas, mais seule la page de blocage porte le titre exact.
  const blocked = detectBlockedSnapshot({ title, html });
  if (blocked) return blocked;

  if (titleHit) return { kind: 'cloudflare', reason: `titre « ${title} »` };
  if (selectorHit) return { kind: 'cloudflare', reason: 'formulaire de vérification' };
  if (urlHit) return { kind: 'cloudflare', reason: 'URL de challenge' };
  if (htmlHit) return { kind: 'cloudflare', reason: `marqueur ${htmlHit}` };
  return null;
}

/** Résumé technique pour le journal (jamais affiché tel quel à l'utilisateur). */
export function challengeDebugInfo({ title = '', url = '' } = {}) {
  return `titre=${JSON.stringify(String(title).slice(0, 80))} url=${String(url).slice(0, 120)}`;
}
