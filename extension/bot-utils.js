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
  // Détection d'un blocage pare-feu Cloudflare (erreur 1020) : ce n'est pas un
  // challenge, rien ne se débloquera en attendant.
  var BLOCKED_TITLES = [
    "sorry, you have been blocked",
    "you have been blocked",
    "désolé, vous avez été bloqué",
    "desole, vous avez ete bloque",
  ];
  var CHALLENGE_TITLES = [
    "just a moment",
    "attention required",
    "checking your browser",
    "un instant",
    "vérification de sécurité",
    "verification de securite",
  ];
  // Boutons d'action d'un profil : les cliquer à la place d'un lien de bio est
  // l'erreur la plus coûteuse, car elle « réussit » sans visiter la cible.
  // Comparaison en minuscules, apostrophes unifiées : « S’abonner » avec une
  // apostrophe typographique doit être reconnu comme « S'abonner ».
  var ACTION_LABELS = /^(s'abonner|se desabonner|abonnement|suivre|ne plus suivre|se connecter|connexion|s'inscrire|creer un compte|message|envoyer|partager|enregistrer|j'aime|aimer|commenter|plus|options|fermer|annuler|retour)$/;

  /** Minuscules, sans accents, apostrophes unifiées et espaces normalisés. */
  function foldLabel(value) {
    return String(value == null ? "" : value)
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[\u2018\u2019\u02bc\u0060]/g, "'")
      .toLocaleLowerCase("fr")
      .replace(/\s+/g, " ")
      .trim();
  }
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
    // null = port non fourni (défaut du protocole) ; 0 = port explicitement nul (refusé).
    var rawPort = source.port;
    var port = rawPort === null || rawPort === undefined || rawPort === "" ? null : Number(rawPort);
    var username = String(source.username == null ? "" : source.username);
    var password = String(source.password == null ? "" : source.password);

    if (!scheme) return { ok: false, message: "Protocole proxy attendu : http, https ou socks5." };
    if (!host) return { ok: false, message: "Hôte du proxy manquant." };
    if (host.indexOf(":") >= 0) return { ok: false, message: "Les adresses IPv6 ne sont pas prises en charge; utilisez l’hôte fourni par Webshare." };
    if (!HOSTNAME_RE.test(host) && !IPV4_RE.test(host)) return { ok: false, message: "Hôte de proxy invalide (sans protocole, chemin ni espace)." };
    if (isBlockedHost(host)) return { ok: false, message: "Hôte local ou privé refusé pour un proxy." };
    // Port omis (null) : on applique le port par défaut documenté du protocole
    // plutôt que de rejeter la ligne — un proxy collé reste une entrée. Un
    // port 0 écrit explicitement reste une faute de saisie et est refusé.
    if (port === null) port = DEFAULT_PROXY_PORTS[scheme] || 8000;
    if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, message: "Port du proxy invalide (1 à 65535)." };
    if (!username.trim()) return { ok: false, message: "Nom d’utilisateur du proxy manquant." };
    if (username.length > 512 || password.length > 512) return { ok: false, message: "Identifiants du proxy trop longs (512 caractères maximum)." };
    if (!password) return { ok: false, message: "Mot de passe du proxy manquant." };

    return { ok: true, value: { scheme: scheme, host: host, port: port, username: username, password: password } };
  }

  // Ports par défaut documentés : 8000 chez Rayobyte/Webshare pour HTTP,
  // 1080 pour SOCKS5. Un port absent ne doit pas faire perdre la ligne.
  var DEFAULT_PROXY_PORTS = { "http": 8000, "https": 8000, "socks5": 1080 };

  /**
   * Une passerelle rotationnelle est un point d'entrée unique qui sort par une
   * IP différente à chaque connexion. On la reconnaît à deux signes :
   *  - son nom contient « residential », « rotating » ou « gateway » ;
   *  - le même hôte propose beaucoup de ports, ou le compte n'a qu'une entrée.
   * Sert uniquement à expliquer l'interface, jamais à filtrer.
   */
  function isRotatingGateway(proxy) {
    if (!proxy) return false;
    var haystack = [proxy.host, proxy.name].map(function (value) {
      return String(value == null ? "" : value).toLowerCase();
    }).join(" ");
    return /(residential|rotating|backconnect|gateway|\.gw\.|spin|proxy-pool)/.test(haystack);
  }

  /**
   * Paramètres de ciblage/session déjà présents dans le mot de passe (ex.
   * « motdepasse-country-US-session-abc-duration-10 »). On les conserve : un
   * mot de passe n'est jamais réécrit à l'aveugle.
   */
  function hasStickySession(password) {
    return /(-session-|-hardsession-)/i.test(String(password == null ? "" : password));
  }

  function hasCountryTargeting(password) {
    return /-country-/i.test(String(password == null ? "" : password));
  }

  /**
   * Construit les identifiants à utiliser pour UNE exécution.
   *
   * Le problème réel : la passerelle résidentielle change d'IP à chaque
   * connexion, donc une seule visite peut sortir par plusieurs adresses et
   * l'IP annoncée n'est jamais celle qui a cliqué. Avec un identifiant de
   * session, le fournisseur fige une IP pour la durée de la visite
   * (Rayobyte : `-session-<id>` et `-duration-<minutes>` ajoutés au mot de passe).
   *
   * Le mot de passe existant est conservé tel quel : les options de ciblage ou
   * une session déjà choisies par l'utilisateur priment toujours.
   */
  function buildProxySession(proxy, sessionId, options) {
    if (!proxy) return null;
    var settings = options || {};
    var password = String(proxy.password == null ? "" : proxy.password);
    if (hasStickySession(password)) {
      return { proxy: proxy, sessionId: "", specialized: false, reason: "session déjà fixée dans le mot de passe" };
    }
    if (!isRotatingGateway(proxy)) {
      return { proxy: proxy, sessionId: "", specialized: false, reason: "adresse fixe, aucune session à créer" };
    }
    var id = String(sessionId == null ? "" : sessionId).replace(/[^a-zA-Z0-9]/g, "").slice(0, 16);
    if (!id) return { proxy: proxy, sessionId: "", specialized: false, reason: "identifiant de session vide" };
    // Durée : assez pour couvrir l'ouverture, le clic et la redirection.
    // Durée : assez pour couvrir l'ouverture, le clic et la redirection. Une
    // valeur absente vaut 5 minutes ; une valeur fournie est bornée, pas
    // remplacée (0 minute doit valoir 1, pas 5).
    var asked = settings.durationMinutes;
    var minutes = asked === null || asked === undefined || asked === ""
      ? 5
      : Math.min(60, Math.max(1, Math.floor(Number(asked) || 1)));
    var suffix = "-session-" + id + "-duration-" + minutes;
    return {
      proxy: {
        id: proxy.id,
        scheme: proxy.scheme,
        host: proxy.host,
        port: proxy.port,
        name: proxy.name,
        username: proxy.username,
        password: password + suffix,
      },
      sessionId: id,
      specialized: true,
      reason: "IP figée pour l’exécution (session " + id + ", " + minutes + " min)",
    };
  }

  /**
   * Vraie IP de sortie portée par l'identifiant (session figée d'un fournisseur
   * résidentiel), en clair. Rayobyte : `-session-<id>` ou `-hardsession-<id>`.
   *
   * Un identifiant de session est ce qui distingue deux adresses sortant par la
   * même passerelle : c'est donc lui, et lui seul, qui identifie l'IP.
   */
  function proxySessionId(proxy) {
    if (!proxy) return "";
    var source = String(proxy.password == null ? "" : proxy.password) + " " +
      String(proxy.username == null ? "" : proxy.username);
    var match = source.match(/(?:^|[-_:\s])(?:hardsession|session)[-_]([A-Za-z0-9]{1,64})(?=$|[-_:\s])/i);
    return match ? match[1] : "";
  }

  /**
   * Clé d'usage : ce que la rotation doit traiter comme « une IP ».
   *
   * - Passerelle sans session (`host:8000` générique) : la clé est l'hôte, car
   *   l'adresse change à chaque connexion et on ne peut pas la distinguer.
   * - Entrée avec sa propre session (`-session-abc123`) : la clé est
   *   `hôte#session`. Chaque ligne est alors une adresse distincte, ce qui est
   *   exactement le cas d'une liste Rayobyte où 3700 lignes ne diffèrent que
   *   par la session. Les compter comme une seule passerelle revenait à
   *   n'utiliser qu'une fraction de la rotation.
   *
   * Le port est volontairement ignoré : il ne distingue pas l'IP de sortie.
   * Aucune empreinte du mot de passe de base n'est conservée, uniquement
   * l'identifiant de session (déjà stocké en clair dans `proxies.last_session`).
   */
  function proxyUsageKey(proxy) {
    if (!proxy) return "";
    // Clé déjà calculée à l'import quand le mot de passe était disponible
    // (côté serveur, la liste ne porte que des identifiants masqués).
    var stored = String(proxy.usageKey != null ? proxy.usageKey : (proxy.usage_key != null ? proxy.usage_key : "")).trim();
    if (stored) return stored;
    var scheme = (normalizeScheme(proxy.scheme || "http") || "http").toLowerCase();
    var base = scheme + "://" + normalizeHost(proxy.host);
    var session = proxySessionId(proxy);
    return session ? base + "#" + session : base;
  }

  /**
   * Nature d'une entrée pour l'affichage : plusieurs entrées d'une même
   * passerelle mais toutes avec leur session sont des IP tournantes distinctes.
   */
  function proxyGatewayLabel(proxy) {
    if (!proxy) return "";
    var base = (normalizeScheme(proxy.scheme || "http") || "http") + "://" + normalizeHost(proxy.host);
    var session = proxySessionId(proxy);
    return session ? base + " · session " + (session.length > 8 ? session.slice(0, 8) + "…" : session) : base;
  }

  function proxySignature(proxy) {
    if (!proxy) return "";
    return [
      normalizeScheme(proxy.scheme || "http"),
      normalizeHost(proxy.host),
      Number(proxy.port) || 0,
      String(proxy.username == null ? "" : proxy.username),
      String(proxy.password == null ? "" : proxy.password),
    ].join("|");
  }

  /**
   * Extrait uniquement les balises publiques d'une passerelle (ex. Rayobyte
   * `-country-US-session-abc123`), sans jamais exposer le mot de passe lui-même.
   */
  function proxyGatewayHint(proxy) {
    if (!proxy) return "";
    var combined = String(proxy.username == null ? "" : proxy.username) + " " + String(proxy.password == null ? "" : proxy.password);
    var parts = [];
    var countryMatch = combined.match(/(?:^|[-_:])country[-_]([A-Za-z]{2})(?=$|[-_:\s])/i);
    if (countryMatch) parts.push(countryMatch[1].toUpperCase());
    var sessionMatch = combined.match(/(?:^|[-_:])session[-_]([A-Za-z0-9]{1,24})(?=$|[-_:\s])/i);
    if (sessionMatch) {
      var sid = sessionMatch[1].length > 8 ? sessionMatch[1].slice(0, 8) + "…" : sessionMatch[1];
      parts.push("session " + sid);
    }
    return parts.join(" · ");
  }

  function isValidPortToken(token) {
    if (!/^\d{1,5}$/.test(String(token == null ? "" : token))) return false;
    var value = Number(token);
    return Number.isInteger(value) && value >= 1 && value <= 65535;
  }

  function isHostToken(token) {
    var normalized = normalizeHost(token);
    return Boolean(normalized) && (HOSTNAME_RE.test(normalized) || IPV4_RE.test(normalized));
  }

  function parseProxyLine(line, options) {
    var settings = options || {};
    var defaultScheme = normalizeScheme(settings.defaultScheme || "http") || "http";
    var rest = String(line || "")
      .replace(/[\uFEFF\u200B-\u200D]/g, "")
      .replace(/\u00A0/g, " ")
      .trim()
      .replace(/^['"]+|['"]+$/g, "")
      .trim();
    if (!rest) return { ok: false, message: "Ligne vide." };
    if (rest.indexOf("\t") >= 0) {
      rest = rest.replace(/\t+/g, ":");
    }

    // Tabulations et espaces servent souvent de séparateur quand on colle
    // depuis un portail : host:port:user:pass avec des tabulations reste
    // une seule entrée, on les ramène au séparateur canonique.
    if (/\s/.test(rest)) rest = rest.replace(/[\t ]+/g, ":").replace(/::+/g, ":");

    var scheme = "";
    var schemeMatch = rest.match(/^(https?|socks5h?):\/\//i);
    if (schemeMatch) {
      var rawScheme = schemeMatch[1].toLowerCase();
      scheme = rawScheme === "socks5h" ? "socks5" : rawScheme;
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
      var beforeAt = rest.slice(0, atIndex);
      var afterAt = rest.slice(atIndex + 1);
      var beforeParts = beforeAt.split(":");
      var afterParts = afterAt.split(":");
      // Deux écritures coexistent : `user:pass@hôte:port` (l'endpoint est après
      // le @) et `hôte:port:user:pass` où un @ peut apparaître dans le mot de
      // passe ou l'e-mail. Une ligne `hôte:port:utilisateur:motdepasse@…` commence déjà par son
      // endpoint : ce qui suit le @ appartient au mot de passe et ne doit pas
      // être relu comme un second endpoint (sinon « mot@passe » est coupé).
      var beforeStartsWithHostPort = beforeParts.length >= 3 &&
        isHostToken(beforeParts[0]) &&
        isValidPortToken(beforeParts[1]) &&
        beforeParts[0].indexOf(".") >= 0;
      // Ce qui suit le @ est l'endpoint : hôte + port, ou hôte seul quand la
      // ligne commence par les identifiants (`user:pass@hôte`).
      var afterIsEndpoint = afterAt.indexOf("[") >= 0 ||
        (afterParts.length >= 2 && isHostToken(afterParts[0]) && isValidPortToken(afterParts[1])) ||
        (afterParts.length === 1 && isHostToken(afterParts[0]) && !beforeStartsWithHostPort);
      var emailInHostPortUserPass = beforeStartsWithHostPort && beforeParts.length === 3 && afterParts.length === 2;

      if (afterIsEndpoint && !emailInHostPortUserPass) {
        var userinfo = beforeAt;
        rest = afterAt;
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
    }

    if (rest.indexOf("[") >= 0) {
      return { ok: false, message: "Les adresses IPv6 ne sont pas prises en charge dans l’import." };
    }

    var parts = rest.split(":");
    if (parts.length < 2) {
      // « host » seul (avec ou sans identifiants) : le port est facultatif
      // quand le fournisseur le fixe (8000 chez Rayobyte, 1080 en SOCKS5).
      // Le défaut est posé par validateProxyEntry selon le protocole.
      if (/^[a-z0-9.-]+$/i.test(rest) && rest.indexOf(".") > 0) {
        parts = [rest];
      } else {
        return { ok: false, message: "Format attendu : host:port:user:pass." };
      }
    }
    if (parts.length === 3) return { ok: false, message: "Format incomplet : host:port:user:pass ou user:pass@host:port." };
    if (parts.length > 4 && hasUserInfo) return { ok: false, message: "Deux jeux d’identifiants dans la même ligne." };

    var host = parts[0];
    var port = parts.length >= 2 ? parts[1] : null;
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

  function splitProxyLineSegments(line) {
    if (line.indexOf(",") < 0 && line.indexOf(";") < 0) return [line];
    var pieces = line.split(/[,;]+/).map(function (item) { return item.trim(); }).filter(Boolean);
    if (pieces.length <= 1) return [line];
    // Ne découpe sur « , » ou « ; » que si chaque segment contient « : » ou une tabulation (un proxy),
    // pour ne jamais couper un mot de passe qui contiendrait une virgule ou un point-virgule.
    var allLookLikeProxies = pieces.every(function (piece) { return piece.indexOf(":") > 0 || piece.indexOf("\t") > 0; });
    return allLookLikeProxies ? pieces : [line];
  }

  function parseProxyLines(text, options) {
    var settings = options || {};
    var entries = [];
    var errors = [];
    var duplicates = 0;
    var seen = Object.create(null);
    var cleanedText = String(text == null ? "" : text)
      .replace(/[\uFEFF\u200B-\u200D]/g, "")
      .replace(/\u00A0/g, " ");
    var lines = cleanedText.split(/\r?\n/);

    lines.forEach(function (rawLine, index) {
      var line = rawLine.trim();
      if (!line || line.charAt(0) === "#") return;
      var segments = splitProxyLineSegments(line);
      segments.forEach(function (segment) {
        var parsed = parseProxyLine(segment, settings);
        if (!parsed.ok) {
          errors.push({ line: index + 1, message: parsed.message });
          return;
        }
        var signature = proxySignature(parsed.value);
        if (seen[signature]) {
          // Doublon dans le texte collé : ignoré, mais compté pour le compte rendu.
          duplicates += 1;
          return;
        }
        seen[signature] = true;
        // Numéro de ligne conservé : indispensable pour corriger un import de
        // plusieurs milliers de lignes (sinon l'erreur est anonyme).
        parsed.value.line = index + 1;
        entries.push(parsed.value);
      });
    });

    return { entries: entries, errors: errors, duplicates: duplicates };
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

    // Règle 1 : le site juge d'abord le réseau de l'IP. Un proxy résidentiel
    // déjà testé passe donc avant toute la liste d'hébergeurs. Les proxys non
    // testés restent éligibles (ils peuvent l'être) ; s'il n'y a aucun
    // résidentiel connu, la liste complète est utilisée : mieux vaut tenter une
    // IP datacenter que ne rien faire.
    var residential = list.filter(function (proxy) { return proxy.ipKind === "residential"; });
    if (residential.length) {
      var untested = list.filter(function (proxy) { return !proxy.ipKind; });
      list = residential.concat(untested);
    }

    // Une visite ne doit jamais partir deux fois de suite de la même IP :
    // la passerelle du cycle précédent est écartée tant qu'il en reste une
    // autre. Sans cette règle, la passe suivante pouvait la reprendre.
    var lastKey = String(settings.lastUsageKey || "");
    if (lastKey) {
      var withoutLast = list.filter(function (proxy) { return proxyUsageKey(proxy) !== lastKey; });
      if (withoutLast.length) list = withoutLast;
    }

    // Tirage équitable : on écarte ensuite les entrées déjà servies dans la
    // passe courante, puis on tire au hasard dedans. L'ancien tirage uniforme
    // sur toute la liste favorisait la même entrée (mesuré : 11 fois sur 12)
    // et laissait les autres inutilisées.
    var usage = settings.usage || {};
    var passes = Number.isInteger(settings.passes) && settings.passes >= 0 ? settings.passes : 0;
    var remaining = list.filter(function (proxy) {
      return (Number(usage[proxyUsageKey(proxy)]) || 0) <= passes;
    });
    // Toutes servies dans cette passe : la suivante commence, tout redevient
    // éligible. Le compteur n'est jamais remis à zéro, il sert de référence.
    if (!remaining.length) {
      remaining = list;
      passes += 1;
    }

    var source = typeof random === "function" ? random : Math.random;
    var value = Number(source());
    if (!Number.isFinite(value)) value = 0;
    value = Math.min(0.999999999, Math.max(0, value));
    var index = Math.floor(value * remaining.length);
    var picked = remaining[index];

    var cursor = Number.isInteger(settings.cursor) ? settings.cursor : 0;
    if (settings.mode !== "random") {
      // Mode ordre : parcours séquentiel, mais parmi les entrées non servies.
      var position = cursor % remaining.length;
      picked = remaining[position];
      cursor = (position + 1) % remaining.length;
    }

    return {
      proxy: picked,
      cursor: cursor,
      index: list.indexOf(picked),
      usageKey: proxyUsageKey(picked),
      passes: passes,
    };
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
   * Débit maximal d'une journée. Conservé pour décrire un débit théorique
   * (l'affichage et les tests), mais il ne plafonne plus rien : le bot
   * enchaîne les clics sans limite quotidienne.
   */
  function maxVisitsPerDay(minimumGapMs) {
    var gap = Number(minimumGapMs) > 0 ? Number(minimumGapMs) : 0;
    if (!gap) return Infinity;
    return Math.max(1, Math.floor(DAY_MS / gap));
  }

  /**
   * Ajuste une sélection au rythme demandé.
   *
   * Plus de plafond quotidien : le nombre saisi est exécuté tel quel, même
   * s'il implique des centaines de clics dans la journée. Le seul ajustement
   * qui subsiste est le minimum de 100 clics par jour, qui relève un nombre
   * trop faible plutôt que de l'abaisser.
   *
   * Retourne { count, requested, minimum, maximum, adjusted }.
   */
  function fitVisitsToRate(requested, days) {
    var wanted = Math.max(1, Math.floor(Number(requested) || 0));
    var span = Math.max(MIN_INTERVAL_DAYS, Math.floor(Number(days) || MIN_INTERVAL_DAYS));
    var minimum = dailyMinimumVisits(span);
    var count = Math.max(wanted, minimum);
    return {
      count: count,
      requested: wanted,
      minimum: minimum,
      // Plus de plafond : `maximum` vaut le total lui-même, pour ne pas mentir
      // à l'interface qui l'affiche.
      maximum: Math.max(count, wanted),
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
    return fitVisitsToRate(count, settings.days).count;
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

  /** Pause par défaut entre deux clics d'une même série (ms). */
  var DEFAULT_CHAIN_GAP_MS = 2500;

  /**
   * Répartit `count` visites sur `days` jours, en les ENCHAÎNANT.
   *
   * Plus de plafond quotidien ni d'écart minimal de 5 minutes : chaque journée
   * exécute son quota d'affilée, avec une pause courte et variable
   * (DEFAULT_CHAIN_GAP_MS, surchargeable par `minimumGapMs`). Si la durée est
   * trop courte pour le nombre demandé, le reliquat suit sans discontinuer
   * au lieu d'être étalé sur des jours fictifs.
   *
   * `minimumGapMs: 0` enchaîne sans aucune pause.
   */
  function buildDailyRunTimes(count, days, startAt, options) {
    var settings = options || {};
    var gapMs = settings.minimumGapMs === undefined || settings.minimumGapMs === null
      ? DEFAULT_CHAIN_GAP_MS
      : Math.max(0, Number(settings.minimumGapMs) || 0);
    var random = typeof settings.random === "function" ? settings.random : Math.random;
    var span = Math.max(MIN_INTERVAL_DAYS, Math.floor(Number(days) || MIN_INTERVAL_DAYS));
    var total = Math.max(1, Math.floor(Number(count) || 0));
    var quota = dailyVisitQuota(total, span);
    if (quota.reduce(function (sum, value) { return sum + value; }, 0) !== total) {
      // Nombre inférieur au minimum quotidien : tout le lot tient le premier jour.
      quota = quota.map(function (value, index) { return index === 0 ? total : 0; });
    }

    var pause = function () {
      if (!gapMs) return 0;
      var value = Number(random());
      if (!Number.isFinite(value)) value = 0.5;
      // ±25 % : le rythme n'est pas parfaitement mécanique, sans rallonger la série.
      return Math.round(gapMs * (0.75 + Math.min(0.999999, Math.max(0, value)) * 0.5));
    };

    var times = [];
    var cursor = startAt;
    for (var day = 0; day < span && times.length < total; day += 1) {
      var wanted = Math.min(quota[day], total - times.length);
      if (!wanted) continue;
      // Chaque journée démarre à son propre créneau : le lot du jour s'enchaîne
      // depuis là, sans attendre la fin de la journée.
      var dayStart = day === 0 ? startAt : startAt + day * DAY_MS;
      cursor = times.length ? Math.max(cursor, dayStart, times[times.length - 1]) : dayStart;
      for (var index = 0; index < wanted; index += 1) {
        if (times.length) cursor += pause();
        times.push(cursor);
      }
    }

    // Sécurité : la durée ne borne jamais le nombre demandé.
    while (times.length < total) {
      cursor = times.length ? times[times.length - 1] + pause() : startAt;
      times.push(cursor);
    }
    return times.slice(0, total);
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

  // ASN des principaux hébergeurs : une IP sur l'un d'eux est un datacenter,
  // ce que Cloudflare juge avant tout le reste.
  var DATACENTER_ASNS = {
    16276: "OVH", 12876: "Scaleway", 51167: "Contabo", 24940: "Hetzner",
    197540: "Netcup", 8560: "IONOS", 20773: "Host Europe", 34011: "Host Europe",
    16509: "Amazon AWS", 14618: "Amazon AWS", 15169: "Google", 396982: "Google Cloud",
    8075: "Microsoft Azure", 8068: "Microsoft", 14061: "DigitalOcean",
    63949: "Linode / Akamai", 20473: "Vultr / Choopa", 26347: "DreamHost",
    46606: "Unified Layer", 26496: "GoDaddy", 32244: "Liquid Web",
    9009: "M247", 51852: "Private Layer", 62240: "Clouvider",
    41378: "Kirino", 199524: "G-Core Labs", 13335: "Cloudflare",
    9002: "RETN", 202425: "IP Volume", 209854: "Zenlayer", 45090: "Tencent",
    55990: "Huawei Cloud", 37963: "Alibaba Cloud", 45102: "Alibaba Cloud",
    47890: "Unmanaged Ltd", 200373: "Ipxo", 208091: "Hostinger",
    47583: "Hostinger", 34241: "Patchstack", 60117: "VSHosting",
  };
  var HOSTING_NAME_RE = /(ovh|hetzner|scaleway|contabo|digitalocean|amazon|aws|google cloud|microsoft|azure|linode|akamai|vultr|hostinger|m247|cloudflare|alibaba|tencent|oracle|leaseweb|netcup|ionos|choopa|godaddy)/i;

  /**
   * Nature d'une IP à partir de son ASN ou du nom de l'organisation.
   *
   * C'est le premier critère de refus d'un site protégé : une IP d'hébergeur
   * est mal notée avant même l'analyse de l'empreinte du navigateur.
   * Renvoie `{ kind: 'datacenter' | 'residential', asn, org, provider }`.
   */
  function classifyIp(info) {
    var source = info || {};
    var asn = Number.isInteger(Number(source.asn)) && Number(source.asn) > 0 ? Number(source.asn) : null;
    var org = String(source.org == null ? "" : source.org).trim();
    if (asn && DATACENTER_ASNS[asn]) {
      return { kind: "datacenter", asn: asn, org: org || DATACENTER_ASNS[asn], provider: DATACENTER_ASNS[asn] };
    }
    if (HOSTING_NAME_RE.test(org)) {
      return { kind: "datacenter", asn: asn, org: org, provider: org };
    }
    // Aucune information (annuaire muet) : ne pas prétendre « résidentiel ».
    if (!asn && !org) return { kind: "unknown", asn: null, org: "", provider: null };
    return { kind: "residential", asn: asn, org: org, provider: null };
  }

  /** Libellé court pour l'interface : « Datacenter · OVH (AS16276) ». */
  function describeIpKind(info) {
    if (!info || !info.kind || info.kind === "unknown") return "Nature d’IP inconnue";
    if (info.kind === "datacenter") {
      var provider = info.provider || info.org || "hébergeur";
      return "Datacenter · " + provider + (info.asn ? " (AS" + info.asn + ")" : "");
    }
    return "Résidentiel · " + (info.org || "fournisseur d’accès") + (info.asn ? " (AS" + info.asn + ")" : "");
  }

  /**
   * Nature d'une page après chargement : `null` si la page réelle est affichée,
   * sinon `{ kind: 'blocked' | 'cloudflare', reason }`.
   *
   * Un blocage 1020 est une décision déjà prise côté serveur ; un challenge est
   * une vérification en cours. Confondre les deux fait attendre pour rien.
   */
  function detectPageGate(snapshot) {
    var source = snapshot || {};
    var title = String(source.title == null ? "" : source.title).toLocaleLowerCase("fr");
    var html = String(source.html == null ? "" : source.html).toLocaleLowerCase("fr");
    if (!title && !html) return null;

    for (var i = 0; i < BLOCKED_TITLES.length; i += 1) {
      if (title.indexOf(BLOCKED_TITLES[i]) >= 0) return { kind: "blocked", reason: "titre « " + String(source.title).slice(0, 80) + " »" };
    }
    if (html.indexOf("error code: 1020") >= 0 || html.indexOf("error 1020") >= 0) {
      return { kind: "blocked", reason: "erreur 1020" };
    }
    if (html.indexOf("cloudflare ray id") >= 0 && html.indexOf("you are unable to access") >= 0) {
      return { kind: "blocked", reason: "page de blocage Cloudflare" };
    }
    for (var j = 0; j < CHALLENGE_TITLES.length; j += 1) {
      if (title.indexOf(CHALLENGE_TITLES[j]) >= 0) return { kind: "cloudflare", reason: "titre « " + String(source.title).slice(0, 80) + " »" };
    }
    if (html.indexOf("challenges.cloudflare.com") >= 0 || html.indexOf("cf-challenge") >= 0 ||
        html.indexOf("cf_chl_opt") >= 0 || html.indexOf("cf-browser-verification") >= 0) {
      return { kind: "cloudflare", reason: "marqueur de vérification" };
    }
    return null;
  }

  /**
   * Reconstruit la destination réelle d'un lien en bio Instagram.
   *
   * Instagram ne redirige pas vers la cible : il passe par
   * `l.instagram.com/?u=<destination>` (mobile) ou `instagram.com/l.php?u=…`.
   * Sans ce décodage, le cycle se termine sur une page d'avertissement et la
   * bio n'est jamais réellement visitée. Fonction pure, testable hors navigateur.
   */
  function unwrapRedirectUrl(rawUrl) {
    var candidate = String(rawUrl == null ? "" : rawUrl).trim();
    if (!candidate) return "";
    for (var hop = 0; hop < 3; hop += 1) {
      var parsed;
      try { parsed = new URL(candidate); } catch (error) { return candidate; }
      var host = parsed.hostname.toLowerCase();
      var isInstagram = /(^|\.)instagram\.com$/.test(host) && (host.indexOf("l.") === 0 || parsed.pathname === "/l.php");
      var isFacebook = /(^|\.)facebook\.com$/.test(host) && parsed.pathname === "/l.php";
      if (!isInstagram && !isFacebook) return candidate;
      var wrapped = parsed.searchParams.get("u") || parsed.searchParams.get("url") || "";
      if (!wrapped) return candidate;
      var decoded = wrapped;
      try { decoded = decodeURIComponent(wrapped); } catch (error) { decoded = wrapped; }
      if (!decoded || decoded === candidate) return candidate;
      candidate = decoded;
    }
    return candidate;
  }

  /**
   * Un lien en bio Instagram n'est pas une balise <a> : c'est un élément
   * cliquable dont le texte est l'URL affichée, souvent tronquée en un mot
   * (« shop », « maboutique »).
   *
   * Un simple mot n'est retenu que s'il n'est pas un libellé d'action : sans
   * cela, « Message » ou « Suivre » seraient pris pour des liens de bio.
   */
  function looksLikeBioLinkText(text) {
    var raw = String(text == null ? "" : text).trim();
    if (!raw || raw.length > 64) return false;
    // URL complète ou domaine : toujours un lien de destination.
    if (/^(?:[a-z0-9-]+\.)+[a-z]{2,24}(?:\/\S*)?$/i.test(raw)) return true;
    // Chemin de type « lien.bio/xxx ».
    if (/^[a-z0-9][a-z0-9._-]{1,40}\/\S*$/i.test(raw)) return true;
    // Simple mot court : éligible seulement s'il ne désigne pas une action.
    if (/^[a-z0-9][a-z0-9._-]*$/i.test(raw) && raw.length <= 32) {
      return !ACTION_LABELS.test(foldLabel(raw));
    }
    return false;
  }

  /**
   * Classe un élément cliquable. La surface et la longueur du texte ne doivent
   * jamais décider à la place du sens : c'est ce qui faisait cliquer
   * « S'abonner » au lieu du lien en bio quand celui-ci était court.
   *
   * @param {{text?:string, href?:string, area?:number, kind?:string,
   *          inNavigation?:boolean, hasClickHandler?:boolean, tagName?:string}} element
   */
  function scoreClickable(element) {
    var source = element || {};
    var text = String(source.text == null ? "" : source.text).trim();
    var href = String(source.href == null ? "" : source.href);
    var area = Number(source.area) || 0;
    var inNavigation = source.inNavigation === true;
    var action = ACTION_LABELS.test(foldLabel(text));
    // Le texte seul ne suffit pas : il faut un élément actionnable.
    var actionable = source.hasClickHandler === true || source.isControl === true ||
      /^(a|button|summary)$/i.test(String(source.tagName || "")) || Boolean(href);
    var bio = actionable && looksLikeBioLinkText(text) && !inNavigation;

    var score = 0;
    score += bio ? 9000 : 0;
    score += inNavigation ? 0 : 1800;
    score += href ? 160 : 0;
    score -= action ? 7000 : 0;
    score += Math.min(text.length, 40) * 10;
    score += Math.min(area / 200, 900);
    if (String(source.kind || "") === "bouton" && !bio) score += 200;

    return { score: Math.round(score), bioLink: bio, actionButton: action };
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
      // Nature de l'IP constatée au dernier test : pilote la priorité de rotation.
      ipKind: /^(residential|datacenter)$/.test(String(raw.ipKind || "")) ? String(raw.ipKind) : "",
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
      // Numéro de passe de la rotation équitable : conservé entre deux ouvertures.
      passes: Number.isInteger(source.passes) && source.passes >= 0 ? source.passes : 0,
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
    MIN_VISITS_PER_DAY: MIN_VISITS_PER_DAY,
    MIN_INTERVAL_DAYS: MIN_INTERVAL_DAYS,
    MAX_INTERVAL_DAYS: MAX_INTERVAL_DAYS,
    maxVisitsPerDay: maxVisitsPerDay,
    fitVisitsToRate: fitVisitsToRate,
    dayKey: dayKey,
    pruneDailyJournal: pruneDailyJournal,
    needsMoreToday: needsMoreToday,
    dailyClickTarget: dailyClickTarget,
    dailyVisitQuota: dailyVisitQuota,
    buildDailyRunTimes: buildDailyRunTimes,
    DEFAULT_CHAIN_GAP_MS: DEFAULT_CHAIN_GAP_MS,
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
    proxyGatewayHint: proxyGatewayHint,
    parseProxyLine: parseProxyLine,
    parseProxyLines: parseProxyLines,
    proxyEndpoint: proxyEndpoint,
    proxyLabel: proxyLabel,
    proxyCredentialsLine: proxyCredentialsLine,
    maskUsername: maskUsername,
    pickProxy: pickProxy,
    isRotatingGateway: isRotatingGateway,
    buildProxySession: buildProxySession,
    proxyUsageKey: proxyUsageKey,
    proxySessionId: proxySessionId,
    proxyGatewayLabel: proxyGatewayLabel,
    hasStickySession: hasStickySession,
    hasCountryTargeting: hasCountryTargeting,
    DEFAULT_PROXY_PORTS: DEFAULT_PROXY_PORTS,
    applyProxyOutcome: applyProxyOutcome,
    detectPageGate: detectPageGate,
    classifyIp: classifyIp,
    describeIpKind: describeIpKind,
    unwrapRedirectUrl: unwrapRedirectUrl,
    looksLikeBioLinkText: looksLikeBioLinkText,
    scoreClickable: scoreClickable,
    sanitizeSavedProxy: sanitizeSavedProxy,
    sanitizeProxySettings: sanitizeProxySettings,
    normalizeOcrLanguage: normalizeOcrLanguage,
    buildOcrWorkerOptions: buildOcrWorkerOptions,
  };

  if (typeof module === "object" && module && module.exports) module.exports = api;
  global.InstaVAUtils = api;
})(typeof globalThis !== "undefined" ? globalThis : self);
