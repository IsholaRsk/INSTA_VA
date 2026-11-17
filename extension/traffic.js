/**
 * Réduction du trafic proxy d'une visite.
 *
 * Chaque visite passe par une IP facturée au Mo (Rayobyte : PAYG, bande
 * passante sans expiration). Une page de destination moderne pèse plusieurs
 * mégaoctets, dont la quasi-totalité — images, vidéos, polices, polices
 * d'icônes — ne sert à RIEN pour l'objectif du bot : trouver un libellé exact
 * et cliquer dessus.
 *
 * Le blocage se fait dans le navigateur, AVANT que les octets ne traversent le
 * proxy : une requête abandonnée ne coûte pas un octet de bande passante. La
 * page continue de se construire normalement (HTML, JSON applicatif, scripts et
 * feuilles de style sont conservés), donc le site voit une visite cohérente.
 *
 * Règle de conception : on ne bloque que ce qui ne peut jamais porter un
 * libellé cliquable ni changer la visibilité d'un élément.
 *
 * Les feuilles de style sont VOLONTAIREMENT épargnées : `getComputedStyle`
 * s'appuie dessus pour `display`, `visibility` et `opacity`. Sans CSS, un
 * élément masqué par la page paraîtrait visible et le bot pourrait cliquer dans
 * le vide. Elles ne pèsent qu'une centaine de kilo-octets, contre des mégaoctets
 * pour les images : le rapport risque/bénéfice est mauvais. Elles restent
 * désactivables pour qui accepte ce compromis.
 */

/**
 * Types de ressources bloqués par défaut, avec les noms EXACTS du protocole
 * Chrome DevTools (`Network.ResourceType` / `Fetch.RequestPattern`).
 */
const DEFAULT_BLOCKED_TYPES = Object.freeze([
  'Image',
  'Media',
  'Font',
]);
// Volontairement limité à trois types qui ont une correspondance EXACTE en
// `declarativeNetRequest`. Y ajouter TextTrack, Manifest ou Prefetch les ferait
// retomber sur le type fourre-tout « other », donc bloquer bien plus que prévu.
// Ces trois-là pèsent par ailleurs quelques kilo-octets : le gain ne vaut pas
// le risque.

/**
 * Types proposables au blocage mais jamais imposés.
 * `Stylesheet` : voir l'avertissement ci-dessus.
 * `Fetch` et `XHR` : ce sont les appels applicatifs de la page, les bloquer
 * casse les sites qui se construisent en JavaScript.
 */
const OPTIONAL_TYPES = Object.freeze(['Stylesheet']);

/**
 * Types qui ne doivent JAMAIS pouvoir être bloqués, même si l'appelant se
 * trompe : sans eux, aucun chargement, aucune détection, aucun clic.
 */
const PROTECTED_TYPES = Object.freeze(['Document', 'Script', 'XHR', 'Fetch']);

/** Toutes les valeurs légales de `Network.ResourceType`, pour filtrer les saisies. */
const KNOWN_TYPES = Object.freeze([
  'Document', 'Stylesheet', 'Image', 'Media', 'Font', 'Script', 'TextTrack',
  'XHR', 'Fetch', 'Prefetch', 'EventSource', 'WebSocket', 'Manifest',
  'SignedExchange', 'Ping', 'CSPViolationReport', 'Preflight', 'FedCM', 'Other',
]);

/**
 * Motifs d'URL bloqués en plus des types : traceurs et mesure d'audience, qui
 * n'apportent rien au rendu utile mais coûtent des octets à chaque visite.
 * Volontairement restreint à des domaines publicitaires/analytiques connus pour
 * ne jamais servir de contenu : une heuristique plus large casserait des pages.
 */
const DEFAULT_BLOCKED_URL_PATTERNS = Object.freeze([
  '*://*.doubleclick.net/*',
  '*://*.googletagmanager.com/*',
  '*://*.googlesyndication.com/*',
  '*://*.google-analytics.com/*',
  '*://*.googleadservices.com/*',
  '*://*.connect.facebook.net/*',
  '*://*.hotjar.com/*',
  '*://*.clarity.ms/*',
  '*://*.sentry.io/*',
  '*://*.newrelic.com/*',
]);

const TYPE_BY_LOWER = new Map(KNOWN_TYPES.map((type) => [type.toLowerCase(), type]));

/**
 * Normalise une liste de types : casse corrigée vers la valeur CDP exacte,
 * sans doublon, sans les types protégés, sans les valeurs inconnues. Une entrée
 * fautive est ignorée plutôt que de faire échouer le cycle : un réglage abîmé
 * ne doit pas arrêter le bot.
 */
function normalizeBlockedTypes(values) {
  const protectedSet = new Set(PROTECTED_TYPES.map((type) => type.toLowerCase()));
  const result = [];
  for (const value of Array.isArray(values) ? values : []) {
    const lower = String(value || '').trim().toLowerCase();
    if (!lower || protectedSet.has(lower)) continue;
    const type = TYPE_BY_LOWER.get(lower);
    if (!type || result.includes(type)) continue;
    result.push(type);
  }
  return result;
}

/**
 * Construit la politique de blocage effective.
 *
 * `blockedTypes` absent laisse les types par défaut ; une liste explicite, même
 * vide, est respectée telle quelle.
 */
function buildBlockPolicy(options = {}) {
  const types = options.blockedTypes === undefined
    ? normalizeBlockedTypes(DEFAULT_BLOCKED_TYPES)
    : normalizeBlockedTypes(options.blockedTypes);
  const patterns = options.blockedUrlPatterns === undefined
    ? [...DEFAULT_BLOCKED_URL_PATTERNS]
    : (Array.isArray(options.blockedUrlPatterns) ? options.blockedUrlPatterns.map(String) : []);
  return {
    types,
    patterns,
    // Un réglage entièrement vide équivaut à ne rien bloquer : autant le dire
    // franchement plutôt que de laisser croire à une économie.
    active: types.length > 0 || patterns.length > 0,
  };
}

/**
 * Estime l'économie à partir d'octets RÉELLEMENT mesurés. Le panneau affiche
 * ce chiffre ; il n'est jamais extrapolé sans mesure.
 */
function summarizeSavings({ beforeBytes, afterBytes, visits }) {
  const before = Math.max(0, Number(beforeBytes) || 0);
  const after = Math.max(0, Number(afterBytes) || 0);
  const count = Math.max(0, Number(visits) || 0);
  const saved = Math.max(0, before - after);
  const ratio = before > 0 ? saved / before : 0;
  return {
    before,
    after,
    saved,
    ratio,
    perVisit: count > 0 ? Math.round(after / count) : 0,
  };
}

/** Formate un nombre d'octets de façon lisible (base 1000, comme les proxy). */
function formatBytes(bytes) {
  const value = Math.max(0, Number(bytes) || 0);
  if (value < 1000) return `${Math.round(value)} o`;
  const units = ['Ko', 'Mo', 'Go', 'To'];
  let scaled = value / 1000;
  let unit = 0;
  while (scaled >= 1000 && unit < units.length - 1) {
    scaled /= 1000;
    unit += 1;
  }
  const rounded = scaled >= 100 ? Math.round(scaled) : scaled.toFixed(scaled >= 10 ? 1 : 2);
  return `${String(rounded).replace('.', ',')} ${units[unit]}`;
}

export {
  DEFAULT_BLOCKED_TYPES,
  DEFAULT_BLOCKED_URL_PATTERNS,
  OPTIONAL_TYPES,
  PROTECTED_TYPES,
  KNOWN_TYPES,
  normalizeBlockedTypes,
  buildBlockPolicy,
  summarizeSavings,
  formatBytes,
};
