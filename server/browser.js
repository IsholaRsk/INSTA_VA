import { assertPublicRequestUrl } from './net-safety.js';

export const CLICKABLE_SELECTOR = 'a[href], [role="link"], button, input[type="button"], input[type="submit"], [role="button"], summary';

const NAVIGATION_TIMEOUT = 45000;
const PAGE_STABLE_MS = 1800;
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
    args: [
      '--disable-dev-shm-usage',
      '--no-sandbox',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
    ],
  };
  if (chromiumPath) launchOptions.executablePath = chromiumPath;
  return playwright.chromium.launch(launchOptions);
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

    const describe = (element, index) => {
      const rect = element.getBoundingClientRect();
      const left = Math.max(0, rect.left);
      const right = Math.min(window.innerWidth, rect.right);
      const top = Math.max(0, rect.top);
      const bottom = Math.min(window.innerHeight, rect.bottom);
      const area = Math.max(0, right - left) * Math.max(0, bottom - top);
      const text = labelOf(element).trim();
      const href = element.tagName === 'A' ? (element.href || '') : '';
      return {
        index,
        label: text.slice(0, 120),
        kind: kindOf(element),
        href: String(href || '').slice(0, 2048),
        score: area + text.length * 60 + (inNavigation(element) ? 0 : 4000) + (kindOf(element) === 'bouton' ? 1200 : 0),
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
 * Exécute un cycle complet : ouvrir l'URL, attendre la stabilisation, cliquer
 * l'élément demandé (ou l'élément principal), attendre la redirection.
 * Un libellé ambigu ou absent de la page annule le cycle sans clic.
 */
export async function runCycle({ browser, url, linkLabel = '', proxy = null, navigationTimeout = NAVIGATION_TIMEOUT }) {
  let context;
  try {
    context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      locale: 'fr-FR',
      userAgent: contextUserAgent(),
      proxy: proxyOption(proxy),
    });
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

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: navigationTimeout });
    await waitForStable(page, navigationTimeout);

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
    const finalUrl = destination.url();
    const title = await destination.title().catch(() => '');
    return {
      initial_url: url,
      final_url: finalUrl,
      title: String(title).slice(0, 200),
      click_label: choice.label,
      click_kind: choice.kind,
      click_href: choice.href || null,
      redirected: true,
      completed_at: new Date().toISOString(),
    };
  } finally {
    if (context) await context.close().catch(() => {});
  }
}

function contextUserAgent() {
  return 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
}
