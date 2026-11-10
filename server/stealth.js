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
  '--disable-features=IsolateOrigins,site-per-process',
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
