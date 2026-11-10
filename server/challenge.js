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
