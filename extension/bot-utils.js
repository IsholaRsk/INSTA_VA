/*
 * Fonctions pures partagées par le panneau latéral.
 * Chargé comme script classique (avant sidepanel.js) et exécuté tel quel dans les tests Node.
 */
(function (global) {
  "use strict";

  // Aucun plafond métier sur le nombre de proxys (seule la mémoire de Chrome limite).
  // Le nombre visé n'est pas plafonné non plus : une borne très haute évite seulement
  // les saisies absurdes (Number.MAX_SAFE_INTEGER, « 1e30 »…).
  var MAX_TARGET_VISITS = 1000000;
  var TARGET_MODES = ["interval", "goal"];
  var MIN_VISITS_PER_DAY = 100;
  var DAY_MS = 24 * 60 * 60 * 1000;
  // Une durée d'intervalle est exprimée en jours (1 à 365).
  var MIN_INTERVAL_DAYS = 1;
  var MAX_INTERVAL_DAYS = 365;
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

  // ───────────────────────── Cibles : modes et libellé facultatif ─────────────────────────

  function normalizeTargetMode(value) {
    var mode = String(value == null ? "" : value).trim().toLowerCase();
    return TARGET_MODES.indexOf(mode) >= 0 ? mode : "interval";
  }

  /**
   * Nombre de visites saisi par l'utilisateur. Plus aucune limite métier : 1 à
   * MAX_TARGET_VISITS (borne technique). Retourne null si la valeur est inutilisable.
   */
  function parseTargetVisits(value) {
    var raw = String(value == null ? "" : value).trim().replace(/[\s\u00a0_]/g, "");
    if (!raw || !/^\d+$/.test(raw)) return null;
    var number = Number(raw);
    if (!Number.isInteger(number) || number < 1 || number > MAX_TARGET_VISITS) return null;
    return number;
  }

  /** Durée en jours d'une cible en mode intervalle (1 à 365). */
  function parseTargetDays(value) {
    var raw = String(value == null ? "" : value).trim().replace(/[\s\u00a0_]/g, "");
    if (!raw || !/^\d+$/.test(raw)) return null;
    var number = Number(raw);
    if (!Number.isInteger(number) || number < MIN_INTERVAL_DAYS || number > MAX_INTERVAL_DAYS) return null;
    return number;
  }

  /**
   * Nombre de visites effectivement planifiées pour un mode donné.
   * Aucun tirage : le nombre saisi est exécuté à l'identique.
   * Le mode intervalle garantit en plus au moins MIN_VISITS_PER_DAY visites par jour
   * sur la durée choisie (sinon le nombre de visites est relevé automatiquement).
   */
  function executionBounds(mode, targetCount) {
    var count = Number(targetCount) || 0;
    return { min: count, max: count, exact: true };
  }

  /** Nombre de visites minimum pour tenir au moins 100 clics par jour sur `days` jours. */
  function dailyMinimumVisits(days) {
    var span = Number(days);
    if (!Number.isFinite(span) || span < MIN_INTERVAL_DAYS) return MIN_VISITS_PER_DAY;
    // Le premier jour compte comme un jour plein : 1 jour => 100 visites.
    return MIN_VISITS_PER_DAY * Math.floor(span);
  }

  /**
   * Débit maximal d'une journée avec l'écart minimal entre deux visites.
   * 5 minutes d'écart => 288 clics maximum par jour.
   */
  function maxVisitsPerDay(minimumGapMs) {
    var gap = Number(minimumGapMs) > 0 ? Number(minimumGapMs) : 5 * 60 * 1000;
    return Math.max(1, Math.floor(DAY_MS / gap));
  }

  /**
   * Ajuste une sélection au rythme réellement tenable :
   *  - au moins 100 clics par jour sur la durée choisie;
   *  - au plus le débit maximal d'une journée (288 avec 5 minutes d'écart).
   * Retourne { count, requested, minimum, maximum, adjusted }.
   */
  function fitVisitsToRate(requested, days, minimumGapMs) {
    var wanted = Math.max(1, Math.floor(Number(requested) || 0));
    var span = Math.max(MIN_INTERVAL_DAYS, Math.floor(Number(days) || MIN_INTERVAL_DAYS));
    var minimum = Math.min(dailyMinimumVisits(span), maxVisitsPerDay(minimumGapMs) * span);
    var maximum = maxVisitsPerDay(minimumGapMs) * span;
    var count = Math.min(Math.max(wanted, minimum), maximum);
    return {
      count: count,
      requested: wanted,
      minimum: minimum,
      maximum: maximum,
      adjusted: count !== wanted,
    };
  }

  /**
   * Nombre de visites réellement exécuté.
   *  - goal     : exactement le nombre cible
   *  - interval : le nombre visé, relevé au minimum quotidien de 100 clics/jour
   */
  function planVisits(mode, targetCount, options) {
    var settings = options || {};
    var count = Math.max(1, Math.floor(Number(targetCount) || 0));
    if (normalizeTargetMode(mode) === "goal") return count;
    if (!settings.enforceDaily) return count;
    return fitVisitsToRate(count, settings.days, settings.minimumGapMs).count;
  }

  /** Nombre de visites à exécuter chaque jour : au moins 100, réparti sur la durée. */
  function dailyVisitQuota(count, days) {
    var visits = Math.max(0, Math.floor(Number(count) || 0));
    var span = Math.max(MIN_INTERVAL_DAYS, Math.floor(Number(days) || MIN_INTERVAL_DAYS));
    if (!visits) return [];
    var base = Math.floor(visits / span);
    var remainder = visits % span;
    var quota = [];
    for (var index = 0; index < span; index += 1) {
      quota.push(base + (index < remainder ? 1 : 0));
    }
    // Le premier jour absorbe les visites supplémentaires si le nombre saisi est
    // inférieur au minimum quotidien (le lot complet est alors fait d'affilée).
    if (base === 0) {
      quota = quota.map(function (value, index) { return index === 0 ? visits : value; });
    }
    return quota;
  }

  /**
   * Répartit `count` visites sur `days` jours.
   * Chaque journée reçoit au moins 100 clics; les horaires d'une journée sont tirés
   * entre le début et la fin de cette journée (au moins 5 minutes d'écart).
   */
  function buildDailyRunTimes(count, days, startAt, options) {
    var settings = options || {};
    var minimumGapMs = Number(settings.minimumGapMs) > 0 ? Number(settings.minimumGapMs) : 5 * 60 * 1000;
    var random = typeof settings.random === "function" ? settings.random : Math.random;
    var span = Math.max(MIN_INTERVAL_DAYS, Math.floor(Number(days) || MIN_INTERVAL_DAYS));
    var total = Math.max(1, Math.floor(Number(count) || 0));
    var quota = dailyVisitQuota(total, span);
    var totalQuota = quota.reduce(function (sum, value) { return sum + value; }, 0);
    if (totalQuota !== total) {
      // Nombre de visites inférieur au minimum quotidien : tout le lot le premier jour.
      quota = quota.map(function (value, index) { return index === 0 ? total : 0; });
    }

    var cap = maxVisitsPerDay(minimumGapMs);
    var times = [];
    for (var day = 0; day < span && times.length < total; day += 1) {
      var perDay = Math.min(quota[day], cap);
      if (!perDay) continue;
      var dayStart = startAt + day * DAY_MS;
      var dayEnd = dayStart + DAY_MS;
      // Fenêtre laissée libre : le reste du temps est réparti aléatoirement.
      var usable = DAY_MS - perDay * minimumGapMs;
      var weights = [];
      var weightSum = 0;
      for (var index = 0; index < perDay; index += 1) {
        var value = -Math.log(Math.max(Number(random()), Number.MIN_VALUE));
        if (!Number.isFinite(value) || value <= 0) value = 1;
        weights.push(value);
        weightSum += value;
      }
      var cursor = dayStart;
      var allocated = 0;
      for (var slot = 0; slot < perDay && times.length < total; slot += 1) {
        var extra = slot === perDay - 1 ? usable - allocated : (usable * weights[slot]) / weightSum;
        extra = Math.max(0, Math.min(extra, Math.max(0, usable - allocated)));
        allocated += extra;
        cursor += extra;
        times.push(Math.max(dayStart, Math.min(dayEnd - 1000, Math.round(cursor))));
        cursor += minimumGapMs;
      }
    }
    // Demande supérieure au débit : on continue les jours suivants, à raison d'un
    // jour plein de clics (le rythme de 100 clics/jour est alors dépassé, pas réduit).
    var overflowDay = span;
    while (times.length < total) {
      var extraStart = startAt + overflowDay * DAY_MS;
      for (var slotOver = 0; slotOver < cap && times.length < total; slotOver += 1) {
        times.push(extraStart + Math.round(slotOver * minimumGapMs));
      }
      overflowDay += 1;
    }
    while (times.length < total) {
      // Sécurité : ne jamais rendre moins d'horaires que demandé.
      times.push(times.length ? times[times.length - 1] + minimumGapMs : startAt);
    }
    return times.sort(function (a, b) { return a - b; });
  }

  /**
   * Journal quotidien : nombre de clics déjà effectués chaque jour.
   * Sert à garantir au moins 100 clics PAR JOUR sur la durée, même si le nombre
   * total saisi est faible (40 clics étalés sur 3 jours ne suffisent pas).
   */
  function dayKey(dateOrTimestamp) {
    var date = new Date(dateOrTimestamp == null ? Date.now() : dateOrTimestamp);
    if (Number.isNaN(date.getTime())) return "";
    return date.toISOString().slice(0, 10);
  }

  function pruneDailyJournal(journal, keepDays, now) {
    var source = journal && typeof journal === "object" ? journal : {};
    var limit = Math.max(1, Math.floor(Number(keepDays) || 31));
    var today = Date.parse(dayKey(now) + "T00:00:00Z");
    var result = {};
    Object.keys(source).forEach(function (key) {
      var parsed = Date.parse(key + "T00:00:00Z");
      if (!Number.isFinite(parsed)) return;
      if (today - parsed <= (limit - 1) * DAY_MS) result[key] = Math.max(0, Math.floor(Number(source[key]) || 0));
    });
    return result;
  }

  /**
   * Objectif de clics à atteindre dans la journée.
   *  - base : quota quotidien du plan, relevé au minimum de 100 clics/jour;
   *  - retard : les jours précédents n'ayant pas atteint 100 clics sont rattrapés,
   *    sans dépasser 100 clics de rattrapage par jour (pour ne pas tout empiler).
   */
  function dailyClickTarget(options) {
    var settings = options || {};
    var quota = Math.max(0, Math.floor(Number(settings.plannedToday) || 0));
    var done = Math.max(0, Math.floor(Number(settings.doneToday) || 0));
    var minimum = Math.max(0, Math.floor(Number(settings.minimumToday) || 0));
    var backlog = Math.max(0, Math.floor(Number(settings.backlog) || 0));
    var base = Math.max(quota, minimum);
    if (done < base) return base + Math.min(backlog, minimum);
    return base + Math.min(backlog, minimum);
  }

  /** Reste-t-il des clics à faire aujourd'hui (quota, minimum et rattrapage) ? */
  function needsMoreToday(options) {
    var settings = options || {};
    var done = Math.max(0, Math.floor(Number(settings.doneToday) || 0));
    return done < dailyClickTarget(settings);
  }

  /** Pause entre deux visites enchaînées dans un même lot (mode objectif). */
  function nextVisitDelayMs(baseMs, random) {
    var base = Number(baseMs);
    if (!Number.isFinite(base) || base < 0) base = 0;
    var source = typeof random === "function" ? random : Math.random;
    var value = Number(source());
    if (!Number.isFinite(value) || value < 0) value = 0;
    if (value >= 1) value = 0.9999999999999999;
    // ±40 % de jitter : le rythme reste humain sans allonger inutilement le lot.
    return Math.round(base * (0.6 + value * 0.8));
  }

  /** Un libellé vide est autorisé : le bot se contente d'ouvrir la page et de cliquer. */
  /**
   * Un libellé peut déclencher une action sensible : toujours confirmer avant le clic.
   * Sans libellé, le lien choisi automatiquement est aussi soumis à confirmation.
   */
  function isSensitiveLabel(value) {
    var normalized = String(value || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase();
    var patterns = [
      /\b(?:login|log in|sign in|connexion|se connecter|connecter|s[’']?identifier)\b/,
      /\b(?:sign up|register|inscription|creer un compte|ouvrir un compte)\b/,
      /\b(?:buy|purchase|checkout|payer|paiement|commander|acheter|subscribe|abonnement)\b/,
      /\b(?:delete|supprimer|desactiver|logout|deconnexion|log out)\b/,
      /\b(?:confirm|confirmer|valider|submit|envoyer|send|continuer|publish|publier|post|poster|follow|suivre|like|aimer|comment|commenter)\b/,
      /\b(?:password|mot de passe|otp|code|verification|verify|2fa|authentification)\b/,
    ];
    return patterns.some(function (pattern) { return pattern.test(normalized); });
  }

  function normalizeLinkLabel(value) {
    var label = String(value == null ? "" : value).trim().replace(/\s+/g, " ");
    if (label.length > 100) return { ok: false, label: "", message: "Le libellé doit faire 100 caractères maximum." };
    return { ok: true, label: label };
  }

  function describeTargetPlan(target) {
    var mode = normalizeTargetMode(target && target.mode);
    var visits = Number(target && target.executionTarget) || 0;
    var label = String((target && target.linkLabel) || "").trim();
    var click = label ? `cliquer « ${label} »` : "cliquer le lien principal de la page";
    if (mode === "goal") {
      return `${visits} visite(s) d’affilée, sans durée : ${click} puis passer à la suivante.`;
    }
    return `visée ${visits} sur ${Number(target && target.durationDays) || 0} jour(s) : ${click}.`;
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
    MAX_CONSECUTIVE_FAILURES: MAX_CONSECUTIVE_FAILURES,
    MAX_TARGET_VISITS: MAX_TARGET_VISITS,
    TARGET_MODES: TARGET_MODES.slice(),
    MIN_VISITS_PER_DAY: MIN_VISITS_PER_DAY,
    DAY_MS: DAY_MS,
    MAX_INTERVAL_DAYS: MAX_INTERVAL_DAYS,
    normalizeTargetMode: normalizeTargetMode,
    parseTargetVisits: parseTargetVisits,
    parseTargetDays: parseTargetDays,
    dailyMinimumVisits: dailyMinimumVisits,
    maxVisitsPerDay: maxVisitsPerDay,
    fitVisitsToRate: fitVisitsToRate,
    dayKey: dayKey,
    pruneDailyJournal: pruneDailyJournal,
    needsMoreToday: needsMoreToday,
    dailyClickTarget: dailyClickTarget,
    dailyVisitQuota: dailyVisitQuota,
    buildDailyRunTimes: buildDailyRunTimes,
    executionBounds: executionBounds,
    planVisits: planVisits,
    nextVisitDelayMs: nextVisitDelayMs,
    normalizeLinkLabel: normalizeLinkLabel,
    isSensitiveLabel: isSensitiveLabel,
    describeTargetPlan: describeTargetPlan,
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
