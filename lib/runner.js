import { isIP } from 'node:net';
import sparticuzChromium from '@sparticuz/chromium';
import { chromium as playwrightChromium } from 'playwright-core';
import {
  assertPublicRequestUrl,
  getSensitiveLabelReason,
  safeErrorMessage,
  supabaseRpc,
  supabaseTable,
} from './shared.js';

const NAVIGATION_TIMEOUT = 45 * 1000;
const PAGE_STABLE_MS = 1800;
const REDIRECT_TIMEOUT = 25 * 1000;

function normalizeLabel(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('fr')
    .replace(/\s+/g, ' ')
    .trim();
}

function publicResultError(error) {
  const text = safeErrorMessage(error);
  if (/DNS privé|DNS .*privé|Adresse IP privée|Hôte local|bloqué/i.test(text)) {
    return 'Une requête vers une adresse locale ou privée a été bloquée.';
  }
  return text;
}

async function waitForPageStable(page, timeout = NAVIGATION_TIMEOUT) {
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
    const readyState = await page.evaluate(() => document.readyState).catch(() => 'loading');
    if (Date.now() - stableAt >= PAGE_STABLE_MS && readyState === 'complete') return lastUrl;
  }
  throw new Error('Délai dépassé pendant la stabilisation de la page.');
}

async function findVisibleExactLinks(page, label) {
  const expected = normalizeLabel(label);
  return page.evaluate((target) => {
    const normalize = (value) => String(value || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLocaleLowerCase('fr')
      .replace(/\s+/g, ' ')
      .trim();
    return Array.from(document.querySelectorAll('a[href], [role="link"]'))
      .map((element, index) => {
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        const rendered = typeof element.checkVisibility !== 'function' || element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
        if (!rendered || !rect.width || !rect.height || rect.bottom <= 0 || rect.right <= 0 ||
            rect.top >= window.innerHeight || rect.left >= window.innerWidth) return null;
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0 ||
            style.pointerEvents === 'none' || element.hasAttribute('disabled') || element.getAttribute('aria-disabled') === 'true') return null;
        const visibleText = String(element.innerText || '').replace(/\s+/g, ' ').trim();
        const accessibleText = visibleText || element.getAttribute('aria-label') || '';
        if (normalize(accessibleText) !== target) return null;
        const left = Math.max(0, rect.left);
        const right = Math.min(window.innerWidth, rect.right);
        const top = Math.max(0, rect.top);
        const bottom = Math.min(window.innerHeight, rect.bottom);
        const rawHref = element.href || element.getAttribute('href') || '';
        if (!rawHref) return null;
        let href = rawHref;
        try { href = new URL(rawHref, document.baseURI).href; } catch {}
        return {
          index,
          x: (left + right) / 2,
          y: (top + bottom) / 2,
          href,
        };
      })
      .filter(Boolean);
  }, expected);
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
      await waitForPageStable(page, NAVIGATION_TIMEOUT);
      return page.url();
    }
  }
  throw new Error('Aucune redirection détectée après le clic.');
}

function proxyOptions(secret) {
  if (!secret) return undefined;
  const rawHost = String(secret.host || '').replace(/^\[|\]$/g, '');
  const host = isIP(rawHost) === 6 ? `[${rawHost}]` : rawHost;
  return {
    server: `${secret.scheme || 'http'}://${host}:${Number(secret.port)}`,
    username: secret.username,
    password: secret.password,
  };
}

async function runBrowserCycle(target, proxy) {
  const browser = await playwrightChromium.launch({
    args: sparticuzChromium.args,
    executablePath: await sparticuzChromium.executablePath(),
    headless: true,
    timeout: 30000,
  });
  let context;
  try {
    context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      locale: 'fr-FR',
      proxy: proxyOptions(proxy),
    });
    const page = await context.newPage();
    page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT);
    page.setDefaultTimeout(12000);
    await context.route('**/*', async (route) => {
      const url = route.request().url();
      let protocol = '';
      try { protocol = new URL(url).protocol; } catch {}
      if (['data:', 'blob:', 'about:'].includes(protocol)) {
        await route.continue();
        return;
      }
      try {
        await assertPublicRequestUrl(url);
        await route.continue();
      } catch {
        await route.abort('blockedbyclient').catch(() => {});
      }
    });

    await page.goto(target.url, { waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT });
    await waitForPageStable(page);
    const visibleLinks = await findVisibleExactLinks(page, target.link_label);
    if (visibleLinks.length === 0) throw new Error('Aucun lien visible ne correspond exactement au libellé demandé.');
    if (visibleLinks.length > 1) throw new Error('Plusieurs liens visibles correspondent au libellé; aucun clic n’a été effectué.');

    const [link] = visibleLinks;
    if (!Number.isInteger(link.index) || !link.href) {
      throw new Error('Le lien correspondant n’est pas cliquable en toute sécurité.');
    }
    await assertPublicRequestUrl(link.href);
    const freshLinks = await findVisibleExactLinks(page, target.link_label);
    if (freshLinks.length !== 1 || freshLinks[0].href !== link.href) {
      throw new Error('Le lien a changé ou n’est plus unique; aucun clic n’a été effectué.');
    }
    const freshLink = freshLinks[0];
    const linkLocator = page.locator('a[href], [role="link"]').nth(freshLink.index);
    const stillVisible = await linkLocator.evaluate((element, expected) => {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      const rendered = typeof element.checkVisibility !== 'function' || element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
      const normalize = (value) => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('fr').replace(/\s+/g, ' ').trim();
      const text = String(element.innerText || '').replace(/\s+/g, ' ').trim() || element.getAttribute('aria-label') || '';
      const rawHref = element.href || element.getAttribute('href') || '';
      if (!rawHref) return false;
      let href = rawHref;
      try { href = new URL(rawHref, document.baseURI).href; } catch {}
      return rendered && Boolean(rect.width && rect.height && rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth) &&
        style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) !== 0 && style.pointerEvents !== 'none' &&
        !element.hasAttribute('disabled') && element.getAttribute('aria-disabled') !== 'true' && normalize(text) === expected.label && href === expected.href;
    }, { label: normalizeLabel(target.link_label), href: link.href });
    if (!stillVisible) throw new Error('Le lien a changé ou n’est plus visible; aucun clic n’a été effectué.');

    const beforeClickUrl = page.url();
    const popupPromise = page.waitForEvent('popup', { timeout: 1800 }).catch(() => null);
    await linkLocator.click({ timeout: 12000 });
    const popup = await popupPromise;
    const destinationPage = popup || page;
    await waitForRedirect(destinationPage, popup ? 'about:blank' : beforeClickUrl);
    const finalUrl = destinationPage.url();
    const title = await destinationPage.title().catch(() => '');
    return {
      initial_url: target.url,
      final_url: finalUrl,
      title: String(title).slice(0, 200),
      click_href: String(link.href).slice(0, 2048),
      redirected: true,
      completed_at: new Date().toISOString(),
    };
  } finally {
    if (context) await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

async function fetchOne(table, filters) {
  const rows = await supabaseTable(table, { select: '*', ...filters, limit: '1' });
  return Array.isArray(rows) ? rows[0] || null : null;
}

async function finishVisit(visit, status, result) {
  await supabaseTable('instava_mobile_visits', {
    id: `eq.${visit.id}`,
    select: 'id',
  }, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ status, result, completed_at: new Date().toISOString() }),
  });
  await refreshRunStatus(visit.run_id);
}

async function refreshRunStatus(runId) {
  const visits = await supabaseTable('instava_mobile_visits', {
    select: 'status',
    run_id: `eq.${runId}`,
  });
  if (!Array.isArray(visits)) return;
  const active = visits.some((row) => ['pending', 'running', 'approval_required'].includes(row.status));
  const status = active
    ? (visits.some((row) => row.status === 'running') ? 'running' : 'scheduled')
    : (visits.length && visits.every((row) => row.status === 'cancelled') ? 'stopped' : 'completed');
  const patch = { status };
  if (!active) patch.finished_at = new Date().toISOString();
  await supabaseTable('instava_mobile_runs', { id: `eq.${runId}` }, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify(patch),
  });
}

export async function runClaimedVisit(visit) {
  let target;
  try {
    const [run, loadedTarget] = await Promise.all([
      fetchOne('instava_mobile_runs', { id: `eq.${visit.run_id}`, user_id: `eq.${visit.user_id}` }),
      fetchOne('instava_mobile_targets', { id: `eq.${visit.target_id}`, user_id: `eq.${visit.user_id}` }),
    ]);
    const snapshot = run?.target_snapshot?.[visit.target_id];
    target = snapshot ? { id: visit.target_id, ...snapshot } : loadedTarget;
    if (!run || !target) throw new Error('La cible ou la session n’existe plus.');

    const sensitiveReason = getSensitiveLabelReason(target.link_label);
    const needsApproval = Boolean(run.confirm_clicks) || Boolean(sensitiveReason);
    if (needsApproval && !visit.approved_at) {
      const reason = run.confirm_clicks
        ? 'Une confirmation est requise avant tout clic.'
        : `Le libellé « ${String(target.link_label).slice(0, 100)} » peut effectuer une action sensible. Confirmez avant le clic.`;
      await supabaseTable('instava_mobile_visits', { id: `eq.${visit.id}` }, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ status: 'approval_required', started_at: null, result: { message: reason } }),
      });
      await refreshRunStatus(visit.run_id);
      return { id: visit.id, status: 'approval_required', message: reason };
    }

    // Re-check the configured endpoint and destination on every execution.
    const [proxySecret] = await Promise.all([
      supabaseRpc('instava_get_proxy_secret', { p_user_id: visit.user_id }),
      assertPublicRequestUrl(target.url),
    ]);
    const result = await runBrowserCycle(target, proxySecret || null);
    await finishVisit(visit, 'success', result);
    return { id: visit.id, status: 'success', finalUrl: result.final_url };
  } catch (error) {
    const message = publicResultError(error);
    await finishVisit(visit, 'failed', { message }).catch(() => {});
    return { id: visit.id, status: 'failed', message };
  }
}

export async function processDueVisits(limit = 2) {
  const claimed = await supabaseRpc('instava_claim_due_visits', { p_limit: Math.min(Math.max(limit, 1), 2) });
  const visits = Array.isArray(claimed) ? claimed : [];
  // Run browsers sequentially to keep peak serverless memory predictable.
  const results = [];
  for (const visit of visits) results.push(await runClaimedVisit(visit));
  return { claimed: visits.length, results };
}

export async function processApprovedVisit(visitId) {
  const claimed = await supabaseRpc('instava_claim_visit', { p_visit_id: visitId });
  const visits = Array.isArray(claimed) ? claimed : [];
  if (!visits.length) return null;
  return runClaimedVisit(visits[0]);
}
