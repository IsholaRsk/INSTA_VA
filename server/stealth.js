/**
 * Empreinte navigateur cohérente pour les sites protégés (Cloudflare…).
 *
 * Principe : ne jamais mentir sur ce qui est vérifiable côté serveur.
 * Un User-Agent annonçant Chrome 131 alors que le moteur est Chrome 158 se
 * voit immédiatement (client hints, empreinte TLS) et suffit à déclencher un
 * challenge. On annonce donc la version réelle, et on ne corrige côté page que
 * les marqueurs d'automatisation que Playwright laisse volontairement.
 */

// Options de lancement : retirent les signaux les plus voyants.
export const STEALTH_ARGS = [
  '--disable-blink-features=AutomationControlled',
  // `--disable-features=IsolateOrigins,site-per-process` était présent : c'est
  // un argument de test qui désactive les protections par site de Chrome, donc
  // un signal d'automatisation repérable. Retiré.
  '--disable-infobars',
  '--no-service-autorun',
  '--password-store=basic',
  '--use-mock-keychain',
  '--disable-component-update',
];

/**
 * Script injecté avant tout script de page. Reste volontairement minimal :
 * chaque surcharge est elle-même un signal si elle est mal faite, donc on se
 * limite à `navigator.webdriver` (le seul drapeau que Playwright pose vraiment)
 * et on n'ajoute rien d'invérifiable.
 */
export function stealthInitScript() {
  return `(() => {
    // 1. navigator.webdriver : Playwright le pose à true en mode automatisé.
    try {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    } catch {}

    // 2. Propriété de contrôle de Playwright, utilisée par certains scripts.
    try { delete Object.getPrototypeOf(navigator).webdriver; } catch {}
  })();`;
}

/**
 * User-Agent dérivé de la version réelle du navigateur.
 * @param {string} browserVersion ex. « 158.0.8127.18 »
 * @param {'linux'|'windows'} platform
 */
export function buildUserAgent(browserVersion, platform = 'linux') {
  const major = String(browserVersion || '').split('.')[0] || '131';
  const full = String(browserVersion || `${major}.0.0.0`).split('.').slice(0, 4).join('.');
  if (platform === 'windows') {
    return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
  }
  return `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${full} Safari/537.36`;
}

/**
 * En-têtes envoyés par un vrai Chrome. Playwright omet `sec-ch-ua` selon les
 * versions ; on les fixe pour rester cohérents avec l'User-Agent annoncé.
 */
export function clientHints(browserVersion, platform = 'linux') {
  const major = String(browserVersion || '').split('.')[0] || '131';
  const brand = '"Chromium";v="' + major + '", "Google Chrome";v="' + major + '", "Not?A_Brand";v="24"';
  return {
    'sec-ch-ua': brand,
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': platform === 'windows' ? '"Windows"' : '"Linux"',
    'sec-ch-ua-arch': platform === 'windows' ? '"x86"' : '"x86"',
    'sec-ch-ua-bitness': '"64"',
  };
}

/** Réglages de contexte alignés sur un vrai bureau (pas de 1280×800 par défaut). */
export function contextProfile(browserVersion, platform = 'linux') {
  return {
    userAgent: buildUserAgent(browserVersion, platform),
    viewport: { width: 1366, height: 768 },
    deviceScaleFactor: 1,
    isMobile: false,
    hasTouch: false,
    locale: 'fr-FR',
    timezoneId: 'Africa/Porto-Novo',
    colorScheme: 'light',
    extraHTTPHeaders: clientHints(browserVersion, platform),
  };
}

/**
 * Diagnostic de l'empreinte présentée au site (règle 3 côté page).
 *
 * Le vrai critère TLS (JA3/JA4) est produit par le moteur Chromium lui-même :
 * piloter un vrai Chrome plutôt qu'une bibliothèque HTTP est déjà la bonne
 * réponse, et aucun réglage applicatif ne peut l'améliorer. Ce qui reste
 * vérifiable et corrigeable, c'est la cohérence de la surface exposée à la
 * page : c'est ce que ce diagnostic mesure et affiche.
 */
export function describeFingerprint({ userAgent = '', hints = {}, webdriver = true, viewport = {}, locales = [], timezone = '' } = {}) {
  const issues = [];

  // La version annoncée doit exister dans l'User-Agent ET dans les client hints.
  const uaVersion = /Chrome\/(\d+)\./.exec(String(userAgent))?.[1] || null;
  const hintVersion = /"Google Chrome";v="(\d+)"/.exec(String(hints?.['sec-ch-ua'] || ''))?.[1] || null;
  if (!uaVersion) issues.push('User-Agent sans version Chrome reconnaissable.');
  if (uaVersion && hintVersion && uaVersion !== hintVersion) {
    issues.push(`Version incohérente : User-Agent Chrome/${uaVersion}, client hints Chrome/${hintVersion}.`);
  }
  if (uaVersion && !hintVersion) issues.push('Client hints absents alors que le User-Agent annonce Chrome.');
  // Un User-Agent Windows avec des hints Linux (ou l'inverse) est un signal fort.
  const uaPlatform = /Windows NT/.test(String(userAgent)) ? 'Windows' : /X11; Linux/.test(String(userAgent)) ? 'Linux' : null;
  const hintPlatform = String(hints?.['sec-ch-ua-platform'] || '').replace(/"/g, '') || null;
  if (uaPlatform && hintPlatform && uaPlatform !== hintPlatform) {
    issues.push(`Système incohérent : User-Agent ${uaPlatform}, client hints ${hintPlatform}.`);
  }
  if (webdriver === true) issues.push('navigator.webdriver est encore à true.');
  if (!viewport?.width || !viewport?.height) issues.push('Viewport non défini.');
  if (!locales?.length) issues.push('Aucune langue déclarée.');
  if (!timezone) issues.push('Aucun fuseau horaire déclaré.');

  return {
    ok: issues.length === 0,
    userAgent: String(userAgent).slice(0, 160),
    uaVersion,
    hintVersion,
    platform: uaPlatform,
    issues,
    // Ce que ce diagnostic ne peut pas mesurer, dit franchement.
    note: 'L’empreinte TLS (JA3/JA4) et HTTP/2 est produite par le moteur Chromium lui-même ; '
      + 'seul un vrai navigateur la produit correctement, ce qui est le cas ici.',
  };
}

/** Construit le diagnostic à partir du profil réellement appliqué au contexte. */
export function fingerprintFromProfile(profile = {}, webdriver = true) {
  return describeFingerprint({
    userAgent: profile.userAgent,
    hints: profile.extraHTTPHeaders || {},
    webdriver,
    viewport: profile.viewport,
    locales: profile.locale ? [profile.locale] : [],
    timezone: profile.timezoneId,
  });
}

/**
 * Version de Chromium attendue, lue depuis le fichier d'inventaire de
 * Playwright. Sert au diagnostic quand aucun navigateur n'est ouvert ; une
 * lecture impossible retombe sur une version vide, ce qui sera signalé.
 */
export function engineVersionFrom(browsersJson, name = 'chromium') {
  try {
    const entry = (browsersJson?.browsers || []).find((item) => item.name === name);
    return String(entry?.browserVersion || '');
  } catch { return ''; }
}
