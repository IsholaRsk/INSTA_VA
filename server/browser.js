import { assertPublicRequestUrl } from './net-safety.js';
import { detectChallengeSnapshot, challengeDebugInfo } from './challenge.js';
import { contextProfile, stealthInitScript, STEALTH_ARGS } from './stealth.js';

export const CLICKABLE_SELECTOR = 'a[href], [role="link"], button, input[type="button"], input[type="submit"], [role="button"], summary';

const NAVIGATION_TIMEOUT = 45000;
// Temps d'observation après un chargement. 1800 ms à chaque visite coûtait
// près de deux secondes par cycle sans rien apporter : la stabilité d'URL et
// `readyState` suffisent à décider que la page est posée. Réglable via
// INSTAVA_PAGE_STABLE_MS pour les sites très lents.
const PAGE_STABLE_MS = Number(process.env.INSTAVA_PAGE_STABLE_MS) > 0
  ? Number(process.env.INSTAVA_PAGE_STABLE_MS)
  : 700;
const REDIRECT_TIMEOUT = 25000;

async function loadPlaywright() {
  try {
    return await import('playwright');
  } catch {
    return import('playwright-core');
  }
}

/**
 * Lance Chromium. En local/VPS on utilise le Chromium installé par
 * `npx playwright install chromium`; la variable CHROMIUM_PATH permet de
 * pointer vers un binaire système (image Docker, distribution minimale).
 */
export async function openBrowser({ chromiumPath = null, headless = true } = {}) {
  const playwright = await loadPlaywright();
  const launchOptions = {
    headless,
    // Signaux d'automatisation retirés + options de discrétion.
    ignoreDefaultArgs: ['--enable-automation'],
    args: [
      '--disable-dev-shm-usage',
      '--no-sandbox',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      ...STEALTH_ARGS,
    ],
  };
  if (chromiumPath) launchOptions.executablePath = chromiumPath;
  const browser = await playwright.chromium.launch(launchOptions);
  // La version réelle sert à construire un User-Agent crédible.
  try { browser.__instavaVersion = browser.version(); } catch { browser.__instavaVersion = ''; }
  return browser;
}

function proxyOption(secret) {
  if (!secret?.host) return undefined;
  const host = String(secret.host).includes(':') && !String(secret.host).startsWith('[')
    ? `[${secret.host}]`
    : String(secret.host);
  return {
    server: `${secret.scheme || 'http'}://${host}:${Number(secret.port)}`,
    username: secret.username,
    password: secret.password,
  };
}

async function waitForStable(page, timeout = NAVIGATION_TIMEOUT) {
  const deadline = Date.now() + timeout;
  let lastUrl = page.url();
  let stableAt = Date.now();
  while (Date.now() < deadline) {
    await page.waitForTimeout(300);
    let currentUrl;
    try { currentUrl = page.url(); } catch { currentUrl = lastUrl; }
    if (currentUrl !== lastUrl) {
      lastUrl = currentUrl;
      stableAt = Date.now();
    }
    const ready = await page.evaluate(() => document.readyState).catch(() => 'loading');
    if (Date.now() - stableAt >= PAGE_STABLE_MS && ready === 'complete') return lastUrl;
  }
  throw new Error('Délai dépassé pendant la stabilisation de la page.');
}

async function waitForRedirect(page, beforeUrl) {
  const deadline = Date.now() + REDIRECT_TIMEOUT;
  let lastUrl = beforeUrl;
  let changedAt = 0;
  while (Date.now() < deadline) {
    await page.waitForTimeout(300);
    let current;
    try { current = page.url(); } catch { current = lastUrl; }
    if (current !== lastUrl) {
      lastUrl = current;
      changedAt = Date.now();
    }
    if (lastUrl !== beforeUrl && changedAt && Date.now() - changedAt >= PAGE_STABLE_MS) {
      await waitForStable(page, NAVIGATION_TIMEOUT);
      return page.url();
    }
  }
  throw new Error('Aucune redirection détectée après le clic.');
}

/**
 * Calcule, dans la page, la liste des éléments cliquables visibles.
 * Le code exécuté dans le navigateur est autonome : il est sérialisé par Playwright.
 */
/**
 * Cœur de la détection, exécuté dans la page. Exporté séparément pour être
 * testé avec un DOM simulé et pour rester identique d'une version à l'autre.
 */
export function clickableCollectorSource() {
  return function collect({ selector, expected }) {
    const normalize = (value) => String(value || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLocaleLowerCase('fr')
      .replace(/\s+/g, ' ')
      .trim();

    const isVisible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      const rendered = typeof element.checkVisibility !== 'function'
        || element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
      return rendered && rect.width > 0 && rect.height > 0 &&
        rect.bottom > 0 && rect.right > 0 &&
        rect.top < window.innerHeight && rect.left < window.innerWidth &&
        style.display !== 'none' && style.visibility !== 'hidden' &&
        Number(style.opacity) !== 0 && style.pointerEvents !== 'none' &&
        !element.hasAttribute('disabled') && element.getAttribute('aria-disabled') !== 'true';
    };

    const labelOf = (element) => {
      if (element.tagName === 'INPUT') {
        return element.value || element.getAttribute('aria-label') || '';
      }
      // innerText reflète le rendu, textContent sert de repli (documents sans mise en page).
      const text = String(element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim();
      return text || element.getAttribute('aria-label') || element.getAttribute('title') || '';
    };

    // Tests par balise plutôt que `instanceof` : robuste quel que soit le contexte JS.
    const kindOf = (element) => {
      if (element.tagName === 'A' || element.getAttribute('role') === 'link') return 'lien';
      if (element.tagName === 'SUMMARY') return 'résumé';
      return 'bouton';
    };

    const inNavigation = (element) => Boolean(element.closest(
      'header, nav, footer, aside, [role="navigation"], [role="banner"], [role="contentinfo"]',
    ));

    // Boutons que l'on clique par erreur si l'on se fie à la surface : ils sont
    // gros, au centre, et n'ont rien à voir avec un lien de destination.
    const ACTION_LABELS = /^(s'abonner|se désabonner|abonnement|suivre|ne plus suivre|se connecter|connexion|s'inscrire|créer un compte|message|envoyer|partager|enregistrer|j'aime|aimer|commenter|plus|options|fermer|annuler|retour)$/;

    // Un lien en bio Instagram n'est pas une balise <a> : c'est un élément
    // cliquable dont le texte est l'URL affichée (lien.bio/xxx), et dont le clic
    // ouvre instagram.com/l.php?u=<destination réelle>. Le reconnaître évite de
    // cliquer à côté et de « réussir » un cycle sans jamais visiter la cible.
    const isBioLink = (element, text) => {
      if (element.closest('header, nav, [role="navigation"], [role="banner"]')) return false;
      const raw = String(text || '').trim();
      if (!raw) return false;
      // Le texte affiché peut être l'URL complète (lien.bio/xxx, linktr.ee/…)
      // mais aussi un simple libellé de la forme « shop », « maboutique » ou
      // « boutique.fr » : Instagram tronque souvent le domaine. On retient donc
      // tout texte court et sans espaces comme candidat, puis la position et la
      // présence d'un gestionnaire de clic font le tri.
      const looksLikeUrl = /^(?:[a-z0-9-]+\.)+[a-z]{2,24}(?:\/\S*)?$/i.test(raw)
        || /^[a-z0-9][a-z0-9._-]{1,40}\/\S*$/i.test(raw)
        || /^l\.instagram\.com\/l\.php\?u=/i.test(raw)
        || (/^[a-z0-9][a-z0-9._-]*$/i.test(raw) && raw.length <= 32);
      if (!looksLikeUrl) return false;
      // Le texte seul ne suffit pas : il doit être actionnable.
      return element.tagName === 'A' || element.tagName === 'BUTTON'
        || element.getAttribute('role') === 'link' || element.getAttribute('role') === 'button'
        || typeof element.onclick === 'function'
        || element.getAttribute('tabindex') !== null
        || Boolean(element.querySelector('a[href]'));
    };

    const describe = (element, index) => {
      const rect = element.getBoundingClientRect();
      const left = Math.max(0, rect.left);
      const right = Math.min(window.innerWidth, rect.right);
      const top = Math.max(0, rect.top);
      const bottom = Math.min(window.innerHeight, rect.bottom);
      const area = Math.max(0, right - left) * Math.max(0, bottom - top);
      const text = labelOf(element).trim();
      const href = element.tagName === 'A' ? (element.href || '') : '';
      const bio = isBioLink(element, text);
      const action = ACTION_LABELS.test(normalize(text));
      // Pondération revue : la surface et la longueur du texte ne doivent pas
      // décider à la place du sens. Un lien de bio passe devant ; un bouton
      // d'action est fortement rétrogradé, même s'il est gros et centré.
      let score = 0;
      score += bio ? 9000 : 0;
      score += inNavigation(element) ? 0 : 1800;
      // Un vrai lien porte une destination : c'est ce qu'on cherche quand
      // aucun libellé n'est fourni. Cette prime reste sous celle de la surface,
      // pour qu'un gros bouton d'appel à l'action garde la priorité.
      score += href ? 160 : 0;
      score -= action ? 7000 : 0;
      // Longueur : un petit bonus seulement, plafonné (un texte long n'est pas
      // plus cliquable qu'un texte court).
      score += Math.min(text.length, 40) * 10;
      // La surface départage deux éléments de même nature — un gros bouton
      // d'appel à l'action plutôt qu'un petit lien annexe — mais elle ne peut
      // jamais battre un lien en bio, qui a un bonus propre.
      score += Math.min(area / 200, 900);
      if (kindOf(element) === 'bouton' && !bio) score += 200;
      return {
        index,
        label: text.slice(0, 120),
        kind: kindOf(element),
        href: String(href || '').slice(0, 2048),
        bio_link: bio,
        action_button: action,
        score: Math.round(score),
      };
    };

    const elements = Array.from(document.querySelectorAll(selector));
    const visible = elements
      .map((element, index) => ({ element, index }))
      .filter(({ element }) => isVisible(element));
    if (expected) {
      return visible
        .filter(({ element }) => normalize(labelOf(element)) === expected)
        .map(({ element, index }) => describe(element, index));
    }
    return visible.map(({ element, index }) => describe(element, index)).sort((a, b) => b.score - a.score);
  };
}

/**
 * Exécute le collecteur dans la page. Le code est sérialisé par Playwright et
 * ne dépend d'aucune variable extérieure au navigateur.
 */
function collectClickables(page, label) {
  return page.evaluate(clickableCollectorSource(), {
    selector: CLICKABLE_SELECTOR,
    expected: label ? normalizeLabel(label) : '',
  });
}

function normalizeLabel(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('fr')
    .replace(/\s+/g, ' ')
    .trim();
}

export function clickableSummary(candidates) {
  return candidates.slice(0, 5).map((item) => `${item.kind} « ${item.label} »`).join(', ');
}

/**
 * Ferme proprement un contexte, en récupérant ses cookies au passage.
 *
 * C'est ce qui rend possible la règle « on ferme la fenêtre et on continue » :
 * une page bloquée n'occupe pas un onglet vivant plus longtemps que nécessaire,
 * mais ce qui a été appris (les cookies) survit au cycle.
 */
export async function closeContext(context, { onStorageState = null } = {}) {
  if (!context) return null;
  let saved = null;
  try { saved = await context.storageState(); } catch { saved = null; }
  await context.close().catch(() => {});
  if (saved && typeof onStorageState === 'function') {
    try { onStorageState(saved); } catch { /* jamais bloquant */ }
  }
  return saved;
}

/**
 * Instagram (et quelques autres) ne redirige pas directement vers la cible :
 * le lien en bio passe par un redirecteur interne, `l.instagram.com/l.php?u=…`.
 * Sans ce décodage, la visite se termine sur une page d'avertissement et le
 * lien de la bio n'est jamais réellement visité.
 *
 * Fonction pure, testable sans navigateur.
 */
export function unwrapRedirectUrl(rawUrl) {
  let candidate = String(rawUrl || '').trim();
  if (!candidate) return '';
  for (let hop = 0; hop < 3; hop += 1) {
    let parsed;
    try { parsed = new URL(candidate); } catch { return candidate; }
    const host = parsed.hostname.toLowerCase();
    // Deux formes existent : l.instagram.com/?u=… (la plus courante depuis le
    // mobile) et instagram.com/l.php?u=… (desktop ancien).
    const isInstagramShim = /(^|\.)instagram\.com$/.test(host)
      && (host.startsWith('l.') || /^\/l\.php$/.test(parsed.pathname));
    const isFacebookShim = /(^|\.)facebook\.com$/.test(host) && /^\/l\.php$/.test(parsed.pathname);
    const wrapped = parsed.searchParams.get('u') || parsed.searchParams.get('url') || '';
    if (!(isInstagramShim || isFacebookShim) || !wrapped) return candidate;
    let decoded = wrapped;
    try { decoded = decodeURIComponent(wrapped); } catch { /* déjà décodé */ }
    if (!decoded || decoded === candidate) return candidate;
    candidate = decoded;
  }
  return candidate;
}

/**
 * Exécute un cycle complet : ouvrir l'URL, attendre la stabilisation, cliquer
 * l'élément demandé (ou l'élément principal), attendre la redirection.
 * Un libellé ambigu ou absent de la page annule le cycle sans clic.
 *
 * Dès qu'un blocage est constaté, la fenêtre est fermée sans attendre la fin du
 * cycle : le worker enchaîne sur la tentative suivante au lieu de laisser un
 * onglet inutile ouvert.
 */
export async function runCycle({
  browser,
  url,
  linkLabel = '',
  proxy = null,
  navigationTimeout = NAVIGATION_TIMEOUT,
  challengeWaitMs = 12000,
  // Cookies et stockage d'une visite précédente sur la même cible. Arriver
  // avec le cookie de clearance évite de repasser un challenge déjà résolu.
  storageState = null,
  // Appelé à la fin du cycle avec l'état mis à jour (jamais bloquant).
  onStorageState = null,
}) {
  let context;
  let savedState = null;
  try {
    const profile = contextProfile(browserVersionOf(browser));
    context = await browser.newContext({
      ...profile,
      proxy: proxyOption(proxy),
      ...(storageState ? { storageState } : {}),
    });
    // Retire navigator.webdriver avant le premier script de la page.
    await context.addInitScript({ content: stealthInitScript() });
    const page = await context.newPage();
    page.setDefaultNavigationTimeout(navigationTimeout);
    page.setDefaultTimeout(12000);

    // Chaque requête (navigation, sous-ressource, clic) est vérifiée : pas d'accès local.
    await context.route('**/*', async (route) => {
      const requestUrl = route.request().url();
      let protocol = '';
      try { protocol = new URL(requestUrl).protocol; } catch { /* url relative */ }
      if (['data:', 'blob:', 'about:'].includes(protocol)) {
        await route.continue();
        return;
      }
      try {
        await assertPublicRequestUrl(requestUrl);
        await route.continue();
      } catch {
        await route.abort('blockedbyclient').catch(() => {});
      }
    });

    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: navigationTimeout });
    await waitForStable(page, navigationTimeout);

    // Cloudflare et équivalents : la page intermédiaire dure 3 à 8 secondes.
    // On lui laisse le temps de se résoudre avant de conclure à un blocage.
    const challenge = await settleChallenge(page, { userUrl: url, waitMs: challengeWaitMs });
    if (challenge) {
      // Blocage pare-feu : la décision est déjà prise, la fenêtre n'a plus
      // aucune raison de rester ouverte une milliseconde de plus.
      if (challenge.kind === 'blocked') {
        await closeContext(context, { onStorageState });
        context = null;
        throw new ChallengeError(challenge, response ? response.status() : null);
      }
      throw new ChallengeError(challenge, response ? response.status() : null);
    }

    const expected = normalizeLabel(linkLabel);
    const candidates = await collectClickables(page, linkLabel);
    if (!candidates.length) {
      throw new Error(expected
        ? `Aucun lien ou bouton visible ne correspond exactement à « ${String(linkLabel).slice(0, 100)} ».`
        : 'Aucun lien ou bouton cliquable visible sur la page.');
    }
    if (expected && candidates.length > 1) {
      throw new Error(`Plusieurs éléments correspondent à « ${String(linkLabel).slice(0, 100)} » (${clickableSummary(candidates)}); aucun clic effectué.`);
    }

    const [choice] = candidates;
    if (choice.href) await assertPublicRequestUrl(choice.href);

    // Re-validation juste avant le clic : l'élément doit toujours être le même.
    const recheck = await collectClickables(page, linkLabel);
    if (!recheck.length || recheck[0].index !== choice.index) {
      throw new Error('La page a changé pendant la vérification; aucun clic effectué.');
    }

    const locator = page.locator(CLICKABLE_SELECTOR).nth(choice.index);
    const beforeUrl = page.url();
    const popupPromise = page.waitForEvent('popup', { timeout: 1800 }).catch(() => null);
    await locator.click({ timeout: 12000 });
    const popup = await popupPromise;
    const destination = popup || page;
    await waitForRedirect(destination, popup ? 'about:blank' : beforeUrl);
    let finalUrl = destination.url();
    // Lien en bio Instagram : on suit la destination réelle dans le même
    // contexte, donc avec le même proxy et les mêmes cookies.
    const unwrapped = unwrapRedirectUrl(finalUrl);
    if (unwrapped && unwrapped !== finalUrl && /^https?:/i.test(unwrapped)) {
      await assertPublicRequestUrl(unwrapped);
      await destination.goto(unwrapped, { waitUntil: 'domcontentloaded', timeout: navigationTimeout }).catch(() => null);
      await waitForStable(destination, navigationTimeout);
      finalUrl = destination.url();
    }
    const title = await destination.title().catch(() => '');
    // Preuve d'usage du proxy : l'IP vue par un service externe. Null si le
    // service est injoignable — jamais bloquant.
    const exitIp = await readExitIp(destination);
    return {
      initial_url: url,
      final_url: finalUrl,
      title: String(title).slice(0, 200),
      click_label: choice.label,
      click_kind: choice.kind,
      click_href: choice.href || null,
      redirected: true,
      exit_ip: exitIp,
      // Hôte du proxy réellement appliqué au contexte (null = sortie directe).
      proxy_host: proxy?.host || null,
      completed_at: new Date().toISOString(),
    };
  } finally {
    // Récupérés avant la fermeture : c'est ce qui donne un « déjà vu » au
    // prochain cycle (règle 5). Un échec ici ne casse jamais le cycle.
    if (context) savedState = await closeContext(context, { onStorageState });
  }
}

/** Version réelle du moteur, pour un User-Agent cohérent. */
function browserVersionOf(browser) {
  try { return browser.__instavaVersion || browser.version() || ''; } catch { return ''; }
}

/**
 * Erreur dédiée : permet au worker de produire un message clair et de
 * distinguer un blocage anti-bot d'un simple libellé introuvable.
 */
export class ChallengeError extends Error {
  constructor(info, status = null) {
    super('Page de vérification anti-bot (Cloudflare) affichée à la place du site.');
    this.name = 'ChallengeError';
    this.challenge = info?.kind || 'cloudflare';
    this.reason = info?.reason || '';
    this.httpStatus = status;
  }
}

/**
 * Attend la résolution d'une page de challenge, puis renvoie l'état final.
 * Retourne `null` si la page réelle est affichée (ou si ce n'est pas un challenge).
 */
async function settleChallenge(page, { userUrl = '', waitMs = 12000 } = {}) {
  const deadline = Date.now() + waitMs;
  let last = null;
  while (Date.now() < deadline) {
    const snapshot = await readSnapshot(page, userUrl);
    if (!snapshot.challenge) return null;
    // Blocage pare-feu (1020) : la décision est déjà prise côté Cloudflare.
    // Attendre 15 s ne changerait rien et retarderait inutilement le cycle.
    if (snapshot.challenge.kind === 'blocked') {
      return { ...snapshot.challenge, debug: challengeDebugInfo(snapshot) };
    }
    last = snapshot;
    await page.waitForTimeout(700);
  }
  return last?.challenge ? { ...last.challenge, debug: challengeDebugInfo(last) } : null;
}

/**
 * Lit l'IP publique vue par le site, telle que le navigateur la présente.
 *
 * C'est la seule preuve que le proxy sert réellement : une erreur de
 * configuration peut laisser le navigateur sortir directement par l'IP du VPS
 * sans qu'aucune erreur ne soit levée. La requête passe par la page (donc par
 * le contexte, donc par le proxy) et échoue en silence si le service est
 * injoignable — ce n'est jamais bloquant pour le cycle.
 */
const IP_ECHO_ENDPOINT = 'https://api.ipify.org/?format=json';

async function readExitIp(page) {
  try {
    const result = await page.evaluate(async (endpoint) => {
      try {
        const response = await fetch(endpoint, { cache: 'no-store', credentials: 'omit' });
        if (!response.ok) return null;
        const data = await response.json();
        return typeof data?.ip === 'string' ? data.ip : null;
      } catch { return null; }
    }, IP_ECHO_ENDPOINT);
    return result || null;
  } catch { return null; }
}

/** Photographie le titre, l'URL et les marqueurs DOM de la page courante. */
async function readSnapshot(page, userUrl = '') {
  let title = '';
  let html = '';
  let currentUrl = '';
  let selectors = '';
  try { title = await page.title(); } catch { /* page en cours de navigation */ }
  try { currentUrl = page.url(); } catch { currentUrl = userUrl; }
  // Seuls le début du document et les sélecteurs connus sont lus : rapide et suffisant.
  try {
    html = await page.evaluate(() => {
      const head = document.documentElement ? document.documentElement.outerHTML.slice(0, 20000) : '';
      const found = ['#challenge-form', '#challenge-running', '#cf-challenge-running',
        '.cf-browser-verification', 'iframe[src*="challenges.cloudflare.com"]',
        'iframe[src*="captcha-delivery.com"]', '#px-captcha']
        .filter((selector) => { try { return Boolean(document.querySelector(selector)); } catch { return false; } })
        .join('|');
      return head + (found ? ' | selectors=' + found : '');
    });
    const match = /\| selectors=([^|]*)$/.exec(html);
    if (match) { selectors = match[1]; html = html.slice(0, match.index); }
  } catch { /* document non accessible pendant la navigation */ }
  const challenge = detectChallengeSnapshot({ title, html, url: currentUrl, selectors });
  return { title, html, url: currentUrl, selectors, challenge };
}
