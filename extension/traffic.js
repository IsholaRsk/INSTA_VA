/*
 * Réduction du trafic proxy d'une visite.
 *
 * Chargé comme script classique (avant sidepanel.js), exactement comme
 * bot-utils.js : AUCUNE syntaxe de module ES ici. Un `export` ferait rejeter
 * tout le fichier par le navigateur (SyntaxError: Unexpected token 'export'),
 * le panneau lèverait « traffic.js n’a pas été chargé » et plus aucun bouton
 * ne répondrait.
 *
 * Chaque visite passe par une IP facturée au Mo (Rayobyte : PAYG, bande
 * passante sans expiration). Une page de destination moderne pèse plusieurs
 * mégaoctets, dont la quasi-totalité — images, vidéos, polices — ne sert à
 * RIEN pour l'objectif du bot : trouver un libellé exact et cliquer dessus.
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
(function (global) {
  "use strict";

  /**
   * Types de ressources bloqués par défaut, avec les noms EXACTS du protocole
   * Chrome DevTools (`Network.ResourceType` / `Fetch.RequestPattern`).
   *
   * Volontairement limité à trois types qui ont une correspondance EXACTE en
   * `declarativeNetRequest`. Y ajouter TextTrack, Manifest ou Prefetch les
   * ferait retomber sur le type fourre-tout « other », donc bloquer bien plus
   * que prévu. Ces trois-là pèsent par ailleurs quelques kilo-octets.
   */
  var DEFAULT_BLOCKED_TYPES = ["Image", "Media", "Font"];

  /**
   * Types proposables au blocage mais jamais imposés.
   * `Stylesheet` : voir l'avertissement en tête de fichier.
   */
  var OPTIONAL_TYPES = ["Stylesheet"];

  /**
   * Types qui ne doivent JAMAIS pouvoir être bloqués, même si l'appelant se
   * trompe : sans eux, aucun chargement, aucune détection, aucun clic.
   */
  var PROTECTED_TYPES = ["Document", "Script", "XHR", "Fetch"];

  /** Toutes les valeurs légales de `Network.ResourceType`, pour filtrer les saisies. */
  var KNOWN_TYPES = [
    "Document", "Stylesheet", "Image", "Media", "Font", "Script", "TextTrack",
    "XHR", "Fetch", "Prefetch", "EventSource", "WebSocket", "Manifest",
    "SignedExchange", "Ping", "CSPViolationReport", "Preflight", "FedCM", "Other",
  ];

  /**
   * Motifs d'URL bloqués en plus des types : traceurs et mesure d'audience, qui
   * n'apportent rien au rendu utile mais coûtent des octets à chaque visite.
   * Volontairement restreint à des domaines publicitaires/analytiques connus
   * pour ne jamais servir de contenu.
   */
  var DEFAULT_BLOCKED_URL_PATTERNS = [
    "*://*.doubleclick.net/*",
    "*://*.googletagmanager.com/*",
    "*://*.googlesyndication.com/*",
    "*://*.google-analytics.com/*",
    "*://*.googleadservices.com/*",
    "*://*.connect.facebook.net/*",
    "*://*.hotjar.com/*",
    "*://*.clarity.ms/*",
    "*://*.sentry.io/*",
    "*://*.newrelic.com/*",
  ];

  var TYPE_BY_LOWER = (function () {
    var map = Object.create(null);
    KNOWN_TYPES.forEach(function (type) { map[type.toLowerCase()] = type; });
    return map;
  })();

  /**
   * Normalise une liste de types : casse corrigée vers la valeur CDP exacte,
   * sans doublon, sans les types protégés, sans les valeurs inconnues. Une
   * entrée fautive est ignorée plutôt que de faire échouer le cycle : un
   * réglage abîmé ne doit pas arrêter le bot.
   */
  function normalizeBlockedTypes(values) {
    var protectedSet = Object.create(null);
    PROTECTED_TYPES.forEach(function (type) { protectedSet[type.toLowerCase()] = true; });
    var result = [];
    (Array.isArray(values) ? values : []).forEach(function (value) {
      var lower = String(value == null ? "" : value).trim().toLowerCase();
      if (!lower || protectedSet[lower]) return;
      var type = TYPE_BY_LOWER[lower];
      if (!type || result.indexOf(type) >= 0) return;
      result.push(type);
    });
    return result;
  }

  /**
   * Construit la politique de blocage effective.
   *
   * `blockedTypes` absent laisse les types par défaut ; une liste explicite,
   * même vide, est respectée telle quelle.
   */
  function buildBlockPolicy(options) {
    var settings = options || {};
    var types = settings.blockedTypes === undefined
      ? normalizeBlockedTypes(DEFAULT_BLOCKED_TYPES)
      : normalizeBlockedTypes(settings.blockedTypes);
    var patterns = settings.blockedUrlPatterns === undefined
      ? DEFAULT_BLOCKED_URL_PATTERNS.slice()
      : (Array.isArray(settings.blockedUrlPatterns) ? settings.blockedUrlPatterns.map(String) : []);
    return {
      types: types,
      patterns: patterns,
      // Un réglage entièrement vide équivaut à ne rien bloquer : autant le dire
      // franchement plutôt que de laisser croire à une économie.
      active: types.length > 0 || patterns.length > 0,
    };
  }

  /**
   * Estime l'économie à partir d'octets RÉELLEMENT mesurés. Le panneau affiche
   * ce chiffre ; il n'est jamais extrapolé sans mesure.
   */
  function summarizeSavings(options) {
    var source = options || {};
    var before = Math.max(0, Number(source.beforeBytes) || 0);
    var after = Math.max(0, Number(source.afterBytes) || 0);
    var count = Math.max(0, Number(source.visits) || 0);
    var saved = Math.max(0, before - after);
    var ratio = before > 0 ? saved / before : 0;
    return {
      before: before,
      after: after,
      saved: saved,
      ratio: ratio,
      perVisit: count > 0 ? Math.round(after / count) : 0,
    };
  }

  /** Formate un nombre d'octets de façon lisible (base 1000, comme les proxy). */
  function formatBytes(bytes) {
    var value = Math.max(0, Number(bytes) || 0);
    if (value < 1000) return Math.round(value) + " o";
    var units = ["Ko", "Mo", "Go", "To"];
    var scaled = value / 1000;
    var unit = 0;
    while (scaled >= 1000 && unit < units.length - 1) {
      scaled /= 1000;
      unit += 1;
    }
    var rounded = scaled >= 100 ? Math.round(scaled) : scaled.toFixed(scaled >= 10 ? 1 : 2);
    return String(rounded).replace(".", ",") + " " + units[unit];
  }

  /**
   * Lit une limite de Mo saisie par l'utilisateur.
   *  - vide, 0 ou négatif  → aucune limite (null)
   *  - nombre valide       → octets (base 1000, comme le fournisseur facture)
   *  - texte invalide      → null, avec un message pour l'interface
   */
  function parseMegabyteLimit(value) {
    if (value === null || value === undefined || String(value).trim() === "") {
      return { ok: true, bytes: null, megabytes: null, message: "" };
    }
    var number = Number(String(value).replace(",", "."));
    if (!Number.isFinite(number)) {
      return { ok: false, bytes: null, megabytes: null, message: "Limite en Mo invalide : saisis un nombre." };
    }
    if (number <= 0) return { ok: true, bytes: null, megabytes: null, message: "" };
    // 1 Go par prudence : au-delà, la saisie est presque sûrement une faute.
    if (number > 1024 * 1024) {
      return { ok: false, bytes: null, megabytes: null, message: "Limite en Mo trop élevée (1 048 576 Mo maximum)." };
    }
    return { ok: true, bytes: Math.round(number * 1000 * 1000), megabytes: number, message: "" };
  }

  /**
   * Décide si une visite peut partir au regard du plafond de consommation.
   *
   * `usedBytes` est la consommation MESURÉE cumulée (jamais extrapolée).
   * `reserveBytes` couvre le coût d'une visite supplémentaire : sans marge, le
   * bot dépasserait le plafond à chaque dernière visite, puisque les octets ne
   * sont connus qu'APRÈS le chargement.
   *
   * Retourne { allowed, reason, remainingBytes, usedBytes, limitBytes }.
   */
  function evaluateTrafficBudget(options) {
    var settings = options || {};
    var limit = settings.limitBytes === null || settings.limitBytes === undefined
      ? null
      : Math.max(0, Number(settings.limitBytes) || 0);
    var used = Math.max(0, Number(settings.usedBytes) || 0);
    var reserve = Math.max(0, Number(settings.reserveBytes) || 0);

    if (limit === null) {
      return { allowed: true, reason: "no-limit", remainingBytes: null, usedBytes: used, limitBytes: null };
    }
    var remaining = Math.max(0, limit - used);
    if (remaining <= 0) {
      return { allowed: false, reason: "limit-reached", remainingBytes: 0, usedBytes: used, limitBytes: limit };
    }
    // Plafond plus petit qu'une visite : on laisse passer une visite, sinon le
    // bot ne ferait jamais rien. Elle est signalée comme dépassement probable.
    if (reserve > 0 && remaining < reserve) {
      if (used === 0) {
        return { allowed: true, reason: "limit-below-one-visit", remainingBytes: remaining, usedBytes: used, limitBytes: limit };
      }
      return { allowed: false, reason: "reserve-exceeded", remainingBytes: remaining, usedBytes: used, limitBytes: limit };
    }
    return { allowed: true, reason: "within-limit", remainingBytes: remaining, usedBytes: used, limitBytes: limit };
  }

  var api = {
    DEFAULT_BLOCKED_TYPES: DEFAULT_BLOCKED_TYPES.slice(),
    DEFAULT_BLOCKED_URL_PATTERNS: DEFAULT_BLOCKED_URL_PATTERNS.slice(),
    OPTIONAL_TYPES: OPTIONAL_TYPES.slice(),
    PROTECTED_TYPES: PROTECTED_TYPES.slice(),
    KNOWN_TYPES: KNOWN_TYPES.slice(),
    normalizeBlockedTypes: normalizeBlockedTypes,
    buildBlockPolicy: buildBlockPolicy,
    summarizeSavings: summarizeSavings,
    formatBytes: formatBytes,
    parseMegabyteLimit: parseMegabyteLimit,
    evaluateTrafficBudget: evaluateTrafficBudget,
  };

  if (typeof module === "object" && module && module.exports) module.exports = api;
  global.InstaVATraffic = api;
})(typeof globalThis !== "undefined" ? globalThis : self);
