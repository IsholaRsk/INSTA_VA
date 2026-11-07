/*
 * Fonctions pures partagées par le panneau latéral.
 * Chargé comme script classique (avant sidepanel.js) et exécuté tel quel dans les tests Node.
 */
(function (global) {
  "use strict";

  var MAX_SAVED_PROXIES = 100;
  var MAX_CONSECUTIVE_FAILURES = 3;
  var OCR_LANGUAGES = ["fra+eng", "fra", "eng"];
  var DEFAULT_OCR_LANGUAGE = "fra+eng";
  var PROXY_SCHEMES = ["http", "https", "socks5"];
  var HOSTNAME_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/;
  var IPV4_RE = /^(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

  function normalizeHost(value) {
    return String(value == null ? "" : value)
      .trim()
      .toLowerCase()
      .replace(/^\[|\]$/g, "")
      .replace(/\.$/, "");
  }

  function normalizeScheme(value) {
    var scheme = String(value == null ? "" : value).trim().toLowerCase();
    return PROXY_SCHEMES.indexOf(scheme) >= 0 ? scheme : "";
  }

  function isPrivateIpv4(host) {
    var parts = host.split(".").map(Number);
    if (parts.length !== 4 || parts.some(function (part) { return !Number.isInteger(part) || part < 0 || part > 255; })) return true;
    var a = parts[0];
    var b = parts[1];
    return a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168);
  }

  function isBlockedHost(host) {
    if (!host) return true;
    if (host.indexOf(":") >= 0) return true; // IPv6: non pris en charge pour l'import
    if (host === "localhost" || /\.(localhost|local|internal|home\.arpa|test|invalid|example)$/.test(host)) return true;
    if (IPV4_RE.test(host)) return isPrivateIpv4(host);
    return false;
  }

  function validateProxyEntry(raw) {
    var source = raw && typeof raw === "object" ? raw : {};
    var scheme = normalizeScheme(source.scheme || "http");
    var host = normalizeHost(source.host);
    var port = Number(source.port);
    var username = String(source.username == null ? "" : source.username);
    var password = String(source.password == null ? "" : source.password);

    if (!scheme) return { ok: false, message: "Protocole proxy attendu : http, https ou socks5." };
    if (!host) return { ok: false, message: "Hôte du proxy manquant." };
    if (host.indexOf(":") >= 0) return { ok: false, message: "Les adresses IPv6 ne sont pas prises en charge; utilisez l’hôte fourni par Webshare." };
    if (!HOSTNAME_RE.test(host) && !IPV4_RE.test(host)) return { ok: false, message: "Hôte de proxy invalide (sans protocole, chemin ni espace)." };
    if (isBlockedHost(host)) return { ok: false, message: "Hôte local ou privé refusé pour un proxy." };
    if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, message: "Port du proxy invalide (1 à 65535)." };
    if (!username.trim()) return { ok: false, message: "Nom d’utilisateur Webshare manquant." };
    if (username.length > 512 || password.length > 512) return { ok: false, message: "Identifiants du proxy trop longs (512 caractères maximum)." };
    if (!password) return { ok: false, message: "Mot de passe Webshare manquant." };

    return { ok: true, value: { scheme: scheme, host: host, port: port, username: username, password: password } };
  }

  function proxySignature(proxy) {
    if (!proxy) return "";
    return [
      normalizeScheme(proxy.scheme || "http"),
      normalizeHost(proxy.host),
      Number(proxy.port) || 0,
      String(proxy.username == null ? "" : proxy.username),
    ].join("|");
  }

  function parseProxyLine(line, options) {
    var settings = options || {};
    var defaultScheme = normalizeScheme(settings.defaultScheme || "http") || "http";
    var rest = String(line || "").trim();
    if (!rest) return { ok: false, message: "Ligne vide." };

    var scheme = "";
    var schemeMatch = rest.match(/^(https?|socks5):\/\//i);
    if (schemeMatch) {
      scheme = schemeMatch[1].toLowerCase();
      rest = rest.slice(schemeMatch[0].length);
    }

    // Un éventuel chemin ou paramètre est inutile pour un proxy.
    var slash = rest.indexOf("/");
    if (slash >= 0) rest = rest.slice(0, slash);
    rest = rest.replace(/\/+$/, "");
    if (!rest) return { ok: false, message: "Hôte et port manquants." };

    var username = String(settings.defaultUsername == null ? "" : settings.defaultUsername);
    var password = String(settings.defaultPassword == null ? "" : settings.defaultPassword);
    var hasUserInfo = false;

    var atIndex = rest.lastIndexOf("@");
    if (atIndex >= 0) {
      var userinfo = rest.slice(0, atIndex);
      rest = rest.slice(atIndex + 1);
      hasUserInfo = true;
      var separator = userinfo.indexOf(":");
      if (separator < 0) {
        username = userinfo;
        password = "";
      } else {
        username = userinfo.slice(0, separator);
        password = userinfo.slice(separator + 1);
      }
    }

    if (rest.indexOf("[") >= 0) {
      return { ok: false, message: "Les adresses IPv6 ne sont pas prises en charge dans l’import." };
    }

    var parts = rest.split(":");
    if (parts.length < 2) return { ok: false, message: "Format attendu : host:port:user:pass." };
    if (parts.length === 3) return { ok: false, message: "Format incomplet : host:port:user:pass ou user:pass@host:port." };
    if (parts.length > 4 && hasUserInfo) return { ok: false, message: "Deux jeux d’identifiants dans la même ligne." };

    var host = parts[0];
    var port = parts[1];
    if (parts.length >= 4) {
      if (hasUserInfo) return { ok: false, message: "Deux jeux d’identifiants dans la même ligne." };
      username = parts[2];
      password = parts.slice(3).join(":");
    }

    return validateProxyEntry({
      scheme: scheme || defaultScheme,
      host: host,
      port: port,
      username: username,
      password: password,
    });
  }

  function parseProxyLines(text, options) {
    var settings = options || {};
    var entries = [];
    var errors = [];
    var seen = Object.create(null);
    var lines = String(text == null ? "" : text).split(/\r?\n/);

    lines.forEach(function (rawLine, index) {
      var line = rawLine.trim();
      if (!line || line.charAt(0) === "#") return;
      var parsed = parseProxyLine(line, settings);
      if (!parsed.ok) {
        errors.push({ line: index + 1, message: parsed.message });
        return;
      }
      var signature = proxySignature(parsed.value);
      if (seen[signature]) return;
      seen[signature] = true;
      entries.push(parsed.value);
    });

    return { entries: entries, errors: errors };
  }

  function proxyEndpoint(proxy) {
    if (!proxy) return "";
    return (normalizeScheme(proxy.scheme || "http") || "http") + "://" + normalizeHost(proxy.host) + ":" + (Number(proxy.port) || 0);
  }

  function proxyLabel(proxy) {
    if (!proxy) return "";
    var name = String(proxy.name == null ? "" : proxy.name).trim();
    return name || proxyEndpoint(proxy);
  }

  function proxyCredentialsLine(proxy) {
    if (!proxy) return "";
    return [normalizeHost(proxy.host), Number(proxy.port) || 0, proxy.username, proxy.password].join(":");
  }

  function maskUsername(username) {
    var value = String(username == null ? "" : username);
    if (!value) return "";
    if (value.length <= 4) return "•".repeat(value.length);
    return value.slice(0, 3) + "…";
  }

  /**
   * Choisit le prochain proxy actif. `cursor` désigne l'index, dans la liste filtrée
   * des proxys activés, à utiliser pour ce cycle. Retourne le curseur suivant.
   */
  function pickProxy(proxies, state, random) {
    var settings = state || {};
    var list = (Array.isArray(proxies) ? proxies : []).filter(function (proxy) {
      return proxy && proxy.enabled !== false;
    });
    if (!list.length) return { proxy: null, cursor: 0, index: -1 };

    var cursor = Number.isInteger(settings.cursor) ? settings.cursor : 0;
    var index;
    if (settings.mode === "random") {
      var source = typeof random === "function" ? random : Math.random;
      var value = Number(source());
      if (!Number.isFinite(value)) value = 0;
      index = Math.min(list.length - 1, Math.max(0, Math.floor(value * list.length)));
    } else {
      index = ((cursor % list.length) + list.length) % list.length;
    }

    return { proxy: list[index], cursor: (index + 1) % list.length, index: index };
  }

  function toCount(value) {
    var number = Number(value);
    return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
  }

  /**
   * Met à jour les compteurs d'un proxy après un cycle.
   * outcome.status : "success" | "failed" | "skipped" ; outcome.active : booléen.
   */
  function applyProxyOutcome(proxy, outcome, options) {
    var source = proxy && typeof proxy === "object" ? proxy : null;
    if (!source) return null;
    var result = outcome || {};
    var settings = options || {};
    var next = Object.assign({}, source);
    // Un cycle sans proxy actif (« skipped ») ne doit pas fausser les statistiques.
    if (result.active === false || result.status === 'skipped') return next;

    next.uses = toCount(source.uses) + 1;
    next.lastUsedAt = settings.now || new Date().toISOString();

    if (result.status === "success") {
      next.successes = toCount(source.successes) + 1;
      next.consecutiveFailures = 0;
      next.lastError = "";
    } else if (result.status === "failed") {
      next.failures = toCount(source.failures) + 1;
      next.consecutiveFailures = toCount(source.consecutiveFailures) + 1;
      next.lastError = String(result.error || "Échec sans message.").slice(0, 200);
      var threshold = toCount(settings.maxConsecutiveFailures) || MAX_CONSECUTIVE_FAILURES;
      if (settings.autoDisable !== false && next.consecutiveFailures >= threshold && source.enabled !== false) {
        next.enabled = false;
        next.disabledReason = "Désactivé après " + next.consecutiveFailures + " échecs consécutifs.";
      }
    }

    return next;
  }

  function sanitizeSavedProxy(raw) {
    if (!raw || typeof raw !== "object" || typeof raw.id !== "string" || !raw.id) return null;
    var validation = validateProxyEntry(raw);
    if (!validation.ok) return null;
    var value = validation.value;
    var text = function (input, max) {
      return typeof input === "string" ? input.slice(0, max) : "";
    };
    return {
      id: raw.id.slice(0, 64),
      name: text(raw.name, 60),
      scheme: value.scheme,
      host: value.host,
      port: value.port,
      username: value.username,
      password: value.password,
      enabled: raw.enabled !== false,
      uses: toCount(raw.uses),
      successes: toCount(raw.successes),
      failures: toCount(raw.failures),
      consecutiveFailures: toCount(raw.consecutiveFailures),
      lastUsedAt: text(raw.lastUsedAt, 40),
      lastError: text(raw.lastError, 200),
      lastTestAt: text(raw.lastTestAt, 40),
      lastTestIp: text(raw.lastTestIp, 80),
      lastTestError: text(raw.lastTestError, 200),
      disabledReason: text(raw.disabledReason, 200),
      createdAt: text(raw.createdAt, 40),
    };
  }

  function sanitizeProxySettings(raw) {
    var source = raw && typeof raw === "object" ? raw : {};
    return {
      useProxy: source.useProxy !== false,
      mode: source.mode === "random" ? "random" : "round-robin",
      cursor: Number.isInteger(source.cursor) && source.cursor >= 0 ? source.cursor : 0,
      autoDisable: source.autoDisable !== false,
    };
  }

  function normalizeOcrLanguage(value) {
    var language = String(value == null ? "" : value).trim().toLowerCase();
    return OCR_LANGUAGES.indexOf(language) >= 0 ? language : DEFAULT_OCR_LANGUAGE;
  }

  /**
   * Options Tesseract.js v6 : tout est servi depuis extension/vendor/ pour rester hors ligne.
   * `assetBase` doit être absolu (chrome.runtime.getURL) car le worker résout lui-même
   * corePath et langPath depuis sa propre URL.
   * workerBlobURL est désactivé car la CSP MV3 (worker-src 'self') refuse les workers blob:.
   */
  function buildOcrWorkerOptions(assetBase) {
    var base = String(assetBase == null ? "" : assetBase);
    if (base && base.charAt(base.length - 1) !== "/") base += "/";
    return {
      workerPath: base + "worker.min.js",
      corePath: base,
      langPath: base + "lang-data",
      cacheMethod: "write",
      gzip: true,
      workerBlobURL: false,
      legacyCore: false,
      legacyLang: false,
    };
  }

  var api = {
    MAX_SAVED_PROXIES: MAX_SAVED_PROXIES,
    MAX_CONSECUTIVE_FAILURES: MAX_CONSECUTIVE_FAILURES,
    OCR_LANGUAGES: OCR_LANGUAGES.slice(),
    DEFAULT_OCR_LANGUAGE: DEFAULT_OCR_LANGUAGE,
    PROXY_SCHEMES: PROXY_SCHEMES.slice(),
    normalizeHost: normalizeHost,
    normalizeScheme: normalizeScheme,
    isBlockedHost: isBlockedHost,
    validateProxyEntry: validateProxyEntry,
    proxySignature: proxySignature,
    parseProxyLine: parseProxyLine,
    parseProxyLines: parseProxyLines,
    proxyEndpoint: proxyEndpoint,
    proxyLabel: proxyLabel,
    proxyCredentialsLine: proxyCredentialsLine,
    maskUsername: maskUsername,
    pickProxy: pickProxy,
    applyProxyOutcome: applyProxyOutcome,
    sanitizeSavedProxy: sanitizeSavedProxy,
    sanitizeProxySettings: sanitizeProxySettings,
    normalizeOcrLanguage: normalizeOcrLanguage,
    buildOcrWorkerOptions: buildOcrWorkerOptions,
  };

  if (typeof module === "object" && module && module.exports) module.exports = api;
  global.InstaVAUtils = api;
})(typeof globalThis !== "undefined" ? globalThis : self);
