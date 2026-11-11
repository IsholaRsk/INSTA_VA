import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { createAuth } from './auth.js';
import { constantTimeEqual, maskValue } from './crypto.js';
import { HttpError, statusOf } from './errors.js';
import { applySecurityHeaders, clientIp, readJsonBody, sendJson, sendText, serveStatic } from './http.js';
import { createRateLimiter } from './ratelimit.js';
import {
  assertProxyLimit,
  attachSecretKey,
  decryptProxyRow,
  describeExitIp,
  MAX_PROXY_IMPORT_BYTES,
  MAX_PROXY_IMPORT_CHARS,
  nextProxy,
  parseProxyImport,
  probeProxy,
  proxyRow,
  validateProxyEntry,
} from './proxies.js';
import { buildVisitSchedule, clicksAllowedToday, plannedCountForDay } from './schedule.js';
import { createScheduler } from './scheduler.js';
import { createStore, publicVisit } from './store.js';
import { describePlan, MAX_TARGETS, planTarget, validateTargetInput } from './targets.js';
import { dayKeyIn } from './time.js';
import { createWorker } from './worker.js';
import { contextProfile, engineVersionFrom, fingerprintFromProfile } from './stealth.js';
import { readFileSync } from 'node:fs';

// Limites par défaut ; injectables pour les tests et les déploiements partagés.
export const LIMITS = {
  login: { windowMs: 15 * 60 * 1000, max: 10 },
  signup: { windowMs: 60 * 60 * 1000, max: 5 },
};

/**
 * Construit le serveur HTTP complet du bot autonome.
 * `deps` permet d'injecter un faux navigateur dans les tests.
 */
export function createApp({
  config,
  store,
  logger = console,
  openBrowser,
  runCycle,
  startWorker = true,
  limits = LIMITS,
  scheduler: providedScheduler = null,
}) {
  const auth = createAuth({ store, config });

  // Version du moteur Chromium annoncée par Playwright : elle sert au profil et
  // au diagnostic d'empreinte, même quand aucun navigateur n'est lancé.
  const engineVersion = (() => {
    try {
      const file = new URL('../node_modules/playwright-core/browsers.json', import.meta.url);
      return engineVersionFrom(JSON.parse(readFileSync(file, 'utf8'))) || '';
    } catch { return ''; }
  })();
  // Un limiteur par instance : deux serveurs (ou deux tests) ne se bloquent pas.
  const loginLimiter = createRateLimiter(limits.login);
  const signupLimiter = createRateLimiter(limits.signup);
  // Rotation et test des proxys ont besoin de la clé pour déchiffrer les identifiants.
  attachSecretKey(store, config.secretKey);
  let worker = null;
  let scheduler = null;

  /**
   * Proxy du prochain cycle : rotation dans la liste activée, puis compteurs
   * mis à jour par le worker selon le résultat.
   */
  function pickProxy(userId) {
    return nextProxy(store, userId);
  }

  if (openBrowser && runCycle) {
    // Un planificateur peut être fourni (tests de résilience) : la boucle doit
    // alors survivre à ses erreurs, pas les masquer.
    scheduler = providedScheduler || createScheduler({ store, config, log: (message) => logger.info(message) });
    worker = createWorker({
      store, config, scheduler, openBrowser, runCycle, decryptProxy: pickProxy, logger,
      // Résultat d'un cycle imputé au proxy réellement utilisé.
      onProxyOutcome: (proxyId, userId, outcome) => {
        if (!proxyId) return;
        const state = store.getProxyState(userId);
        store.recordProxyOutcome(proxyId, { ...outcome, disableAfter: state.disableAfter });
      },
    });
    if (startWorker) worker.start();
  }

  /* --------------------------------- routes --------------------------------- */

  const routes = [];
  function route(method, pathname, handler, { auth: needsAuth = true } = {}) {
    routes.push({ method, pathname, handler, needsAuth });
  }

  /* --- état du serveur (public) --- */
  route('GET', '/api/health', (req, res) => {
    const ownerExists = store.countUsers() > 0;
    sendJson(res, 200, {
      ok: true,
      version: config.version,
      timeZone: config.timeZone,
      firstRun: !ownerExists,
      setupOpen: !ownerExists || config.allowSignup,
      signupCodeRequired: Boolean(config.signupCode),
      worker: worker
        ? { running: worker.isRunning, active: worker.activeCount, ...(worker.stats || {}) }
        : { running: false, active: 0 },
    });
  }, { auth: false });

  /* --- authentification --- */
  route('POST', '/api/auth/register', async (req, res) => {
    const ip = clientIp(req, config.trustProxy);
    const limit = signupLimiter.check(ip);
    if (!limit.allowed) throw new HttpError(429, `Trop de tentatives. Réessayez dans ${Math.ceil(limit.retryAfterSeconds / 60)} minutes.`);
    const body = await readJsonBody(req);
    const user = auth.register({ email: body.email, password: body.password, signupCode: body.signupCode });
    auth.startSession(req, res, user);
    sendJson(res, 201, { user: { id: user.id, email: user.email, role: user.role } });
  }, { auth: false });

  route('POST', '/api/auth/login', async (req, res) => {
    const ip = clientIp(req, config.trustProxy);
    const limit = loginLimiter.check(ip);
    if (!limit.allowed) throw new HttpError(429, `Trop de tentatives. Réessayez dans ${Math.ceil(limit.retryAfterSeconds / 60)} minutes.`);
    const body = await readJsonBody(req);
    const user = auth.login(body.email, body.password);
    loginLimiter.reset(ip);
    auth.startSession(req, res, user);
    sendJson(res, 200, { user: { id: user.id, email: user.email, role: user.role } });
  }, { auth: false });

  route('POST', '/api/auth/logout', (req, res) => {
    auth.endSession(req, res);
    sendJson(res, 200, { ok: true });
  }, { auth: false });

  route('GET', '/api/auth/me', (req, res, user, session) => {
    sendJson(res, 200, {
      user,
      session: { expiresAt: session.expiresAt },
      timeZone: config.timeZone,
    });
  });

  route('POST', '/api/auth/password', async (req, res, user, session) => {
    const body = await readJsonBody(req);
    auth.changePassword(user, body.currentPassword, body.newPassword, body.confirmPassword, session.id);
    sendJson(res, 200, { ok: true, message: 'Mot de passe modifié. Les autres appareils ont été déconnectés.' });
  });

  /* --- cibles --- */
  route('GET', '/api/targets', (req, res, user) => {
    const targets = store.listTargets(user.id).map((target) => ({ ...target, description: describePlan(target) }));
    sendJson(res, 200, { targets });
  });

  function saveTarget(user, body, existingId = null) {
    const { data, plan } = validateTargetInput(body);
    if (!existingId && store.countTargets(user.id) >= MAX_TARGETS) {
      throw new HttpError(400, `Maximum ${MAX_TARGETS} cibles enregistrées.`);
    }
    if (existingId) store.assertOwned(existingId, user.id);
    const target = existingId
      ? store.updateTarget(user.id, existingId, data)
      : store.createTarget(user.id, data);
    return { target: { ...target, description: describePlan(target) }, plan };
  }

  route('POST', '/api/targets', async (req, res, user) => {
    const body = await readJsonBody(req);
    sendJson(res, 201, saveTarget(user, body));
  });

  route('PATCH', '/api/targets', async (req, res, user) => {
    const body = await readJsonBody(req);
    const id = String(body.id || '');
    if (!id) throw new HttpError(400, 'Identifiant de cible manquant.');
    sendJson(res, 200, saveTarget(user, body, id));
  });

  route('DELETE', '/api/targets', (req, res, user, session, url) => {
    const id = url.searchParams.get('id') || '';
    if (!id) throw new HttpError(400, 'Identifiant de cible manquant.');
    if (!store.deleteTarget(user.id, id)) throw new HttpError(404, 'Cible introuvable.');
    sendJson(res, 200, { ok: true });
  });

  /* --- lancement --- */
  route('POST', '/api/start', async (req, res, user) => {
    if (store.activeRun(user.id)) {
      throw new HttpError(409, 'Une session est déjà en cours. Arrêtez-la avant d’en lancer une autre.');
    }
    const body = await readJsonBody(req);
    const ids = Array.isArray(body.targetIds) ? [...new Set(body.targetIds.map(String))] : [];
    if (!ids.length || ids.length > MAX_TARGETS) throw new HttpError(400, `Sélectionnez de 1 à ${MAX_TARGETS} cibles.`);
    const targets = ids.map((id) => store.getTarget(user.id, id));
    if (targets.some((target) => !target)) throw new HttpError(404, 'Une ou plusieurs cibles sont introuvables.');

    const plannedAt = Date.now();
    const totalVisits = targets.reduce((sum, target) => sum + target.effective_total, 0);
    const rows = [];
    const summary = [];
    for (const target of targets) {
      const times = buildVisitSchedule({
        effectiveTotal: target.effective_total,
        durationDays: target.mode === 'goal' ? 1 : target.duration_days,
        // Le premier cycle part environ une minute après le lancement.
        startAt: plannedAt + 45 * 1000,
      });
      summary.push({ id: target.id, pseudo: target.pseudo, visits: times.length, description: describePlan(target) });
      times.forEach((timestamp, index) => {
        rows.push({
          id: randomUUID(),
          run_id: null,
          user_id: user.id,
          target_id: target.id,
          pseudo_snapshot: target.pseudo,
          visit_number: index + 1,
          scheduled_at: new Date(timestamp).toISOString(),
        });
      });
    }

    const snapshot = Object.fromEntries(targets.map((target) => [target.id, {
      pseudo: target.pseudo, url: target.url, link_label: target.link_label,
      mode: target.mode, execution_target: target.execution_target, duration_days: target.duration_days,
    }]));
    const run = store.createRun(user.id, { confirmClicks: Boolean(body.confirmClicks), targetSnapshot: snapshot });
    for (const row of rows) row.run_id = run.id;
    store.addVisits(rows);
    if (worker) worker.wake();

    sendJson(res, 201, {
      run: { id: run.id, status: run.status, created_at: run.created_at },
      plannedVisits: rows.length,
      targets: summary,
      totalVisits,
    });
  });

  route('POST', '/api/stop', async (req, res, user) => {
    const body = await readJsonBody(req);
    const runId = String(body.runId || '');
    if (runId && !store.getRun(user.id, runId)) throw new HttpError(404, 'Session introuvable.');
    const cancelled = store.cancelPendingVisits(user.id, runId || null);
    if (runId) worker?.refreshRunStatus(runId);
    sendJson(res, 200, { ok: true, cancelled, message: `${cancelled} visite(s) en attente annulée(s).` });
  });

  route('POST', '/api/approve', async (req, res, user) => {
    const body = await readJsonBody(req);
    const visitId = String(body.visitId || '');
    if (!visitId) throw new HttpError(400, 'Identifiant de visite manquant.');
    if (!worker) throw new HttpError(503, 'Le moteur d’exécution n’est pas actif.');
    const visit = worker.approve(user.id, visitId);
    if (!visit) throw new HttpError(404, 'Visite introuvable.');
    sendJson(res, 200, { visit });
  });

  /* --- activité --- */
  route('GET', '/api/visits', (req, res, user) => {
    const runs = store.listRuns(user.id, 15);
    const visits = store.listVisits(user.id, { limit: 80 });
    const today = dayKeyIn(config.timeZone);
    const perTarget = store.listTargets(user.id).map((target) => ({
      target_id: target.id,
      pseudo: target.pseudo,
      today: store.clicksOnDay(user.id, target.id, today),
      // Cumul par cible : affiché à côté du jour dans la nouvelle interface.
      clicksTotal: store.clicksTotalForTarget(user.id, target.id),
      history: store.dailyClicksByTarget(user.id, target.id, 14),
    }));
    sendJson(res, 200, {
      runs,
      visits,
      today,
      todayTotal: store.dailyClicksForUser(user.id, today),
      // Total cumulé : c'est la base du solde affiché dans la carte.
      clicksTotal: store.clicksTotal(user.id),
      clicksByTarget: perTarget,
      stats: store.stats(user.id),
    });
  });

  /* --- proxys (liste illimitée + rotation) --- */
  route('GET', '/api/proxies', (req, res, user) => {
    const proxies = store.listProxies(user.id);
    const state = store.getProxyState(user.id);
    sendJson(res, 200, {
      proxies,
      state,
      totals: {
        count: proxies.length,
        enabled: proxies.filter((proxy) => proxy.enabled).length,
        cycles: proxies.reduce((sum, proxy) => sum + proxy.cycles, 0),
      },
    });
  });

  route('POST', '/api/proxies', async (req, res, user) => {
    // Un fichier texte de plusieurs milliers de lignes ne tient pas dans les
    // 64 Ko par défaut.
    const body = await readJsonBody(req, MAX_PROXY_IMPORT_BYTES);
    const raw = String(body.text || '').trim();
    if (!raw) throw new HttpError(400, 'Collez au moins une ligne de proxy.');
    if (raw.length > MAX_PROXY_IMPORT_CHARS) {
      throw new HttpError(413, `Fichier trop volumineux (${Math.round(raw.length / 1024)} Ko). Limite : ${Math.round(MAX_PROXY_IMPORT_CHARS / 1024)} Ko par import.`);
    }
    const parsed = parseProxyImport(raw, {
      defaultUsername: String(body.defaultUsername || ''),
      defaultPassword: String(body.defaultPassword || ''),
      defaultScheme: String(body.defaultScheme || 'http'),
    });
    assertProxyLimit(parsed.entries.length);
    if (!parsed.entries.length) {
      const detail = parsed.errors.slice(0, 3).map((error) => `ligne ${error.line || '?'} : ${error.message}`).join(' ; ');
      throw new HttpError(400, detail ? `Aucun proxy valide. ${detail}` : 'Aucun proxy valide dans le texte fourni.');
    }

    // Déduplication avec la liste existante (même hôte + port + identifiant).
    const existing = new Set(store.listProxies(user.id).map((proxy) => `${proxy.host}:${proxy.port}:${proxy.username}`));
    // Total de lignes réellement fournies, doublons du fichier compris : c'est
    // la seule base honnête pour un compte rendu (« 9 rejetées sur 17 » mentait).
    const totalLines = parsed.entries.length + parsed.errors.length + parsed.duplicates;
    const checked = [];
    for (const entry of parsed.entries) {
      const signature = `${entry.host}:${entry.port}:${maskValue(entry.username)}`;
      if (existing.has(signature)) { parsed.duplicates += 1; continue; }
      try {
        const valid = await validateProxyEntry(entry);
        checked.push(valid);
        existing.add(signature);
      } catch (error) {
        parsed.errors.push({ line: entry.line || 0, message: error.message });
      }
    }
    if (!checked.length) {
      // Tout était déjà connu : ce n'est pas une erreur, c'est un réimport.
      if (parsed.duplicates && !parsed.errors.length) {
        sendJson(res, 200, {
          added: 0,
          duplicates: parsed.duplicates,
          rejected: 0,
          errors: [],
          state: store.getProxyState(user.id),
          message: `Ces ${parsed.duplicates} proxy(s) sont déjà dans la liste, rien à ajouter.`,
        });
        return;
      }
      const detail = parsed.errors.slice(0, 3).map((error) => `ligne ${error.line || '?'} : ${error.message}`).join(' ; ');
      throw new HttpError(400, `Aucun proxy n’a pu être ajouté. ${detail || 'Doublons uniquement.'}`);
    }

    store.insertProxies(user.id, checked.map((entry, index) => proxyRow(
      entry, config.secretKey, randomUUID(), String(entry.label || `Proxy ${index + 1}`),
    )));
    const state = store.getProxyState(user.id);
    // Le premier import active la rotation : sinon rien ne serait utilisé.
    if (!state.enabled) store.saveProxyState(user.id, { enabled: true });

    sendJson(res, 201, {
      added: checked.length,
      duplicates: parsed.duplicates,
      rejected: parsed.errors.length,
      errors: parsed.errors.slice(0, 10),
      state: store.getProxyState(user.id),
      // Le compte rendu doit alerter quand une grande partie du fichier est rejetée :
      // afficher « 1 ajouté » sans insister ferait croire à un import réussi.
      message: `${checked.length} proxy(s) ajouté(s)${parsed.duplicates ? `, ${parsed.duplicates} doublon(s) ignoré(s)` : ''}`
        + (parsed.errors.length
          ? `. ⚠ ${parsed.errors.length} ligne(s) rejetée(s) sur ${totalLines}.`
          : '.'),
      partial: parsed.errors.length > 0,
    });
  });

  route('PATCH', '/api/proxies', async (req, res, user) => {
    const body = await readJsonBody(req);
    // Réglages de la rotation.
    if (body.state && typeof body.state === 'object') {
      const patch = {};
      if ('enabled' in body.state) patch.enabled = Boolean(body.state.enabled);
      if ('rotation' in body.state) patch.rotation = body.state.rotation === 'random' ? 'random' : 'order';
      if ('disableAfter' in body.state) patch.disableAfter = Number(body.state.disableAfter) || 3;
      sendJson(res, 200, { state: store.saveProxyState(user.id, patch) });
      return;
    }
    const id = String(body.id || '');
    if (!id) throw new HttpError(400, 'Identifiant de proxy manquant.');
    if (!store.getProxyRow(user.id, id)) throw new HttpError(404, 'Proxy introuvable.');
    const patch = {};
    if ('enabled' in body) patch.enabled = body.enabled ? 1 : 0;
    if ('label' in body) patch.label = String(body.label || '').slice(0, 80);
    // Réactiver remet le compteur d'échecs à zéro.
    if (body.enabled) patch.consecutive_failures = 0;
    sendJson(res, 200, { proxy: store.updateProxy(user.id, id, patch) });
  });

  route('DELETE', '/api/proxies', (req, res, user, session, url) => {
    const id = url.searchParams.get('id') || '';
    if (id === 'disabled') {
      const removed = store.deleteDisabledProxies(user.id);
      sendJson(res, 200, { removed, message: `${removed} proxy(s) désactivé(s) supprimé(s).` });
      return;
    }
    // Liste entière : c'est le cas courant, une liste de proxys se remplace.
    if (id === 'all') {
      const removed = store.deleteAllProxies(user.id);
      sendJson(res, 200, { removed, message: `${removed} proxy(s) supprimé(s). La liste est vide.` });
      return;
    }
    if (!id) throw new HttpError(400, 'Identifiant de proxy manquant.');
    if (!store.deleteProxy(user.id, id)) throw new HttpError(404, 'Proxy introuvable.');
    sendJson(res, 200, { ok: true });
  });

  // Diagnostic des règles que l'utilisateur ne peut pas voir autrement :
  // l'empreinte présentée au site (règle 3), les cookies conservés (règle 5)
  // et la nature des IP disponibles (règle 1).
  route('GET', '/api/diagnostic', (req, res, user) => {
    const proxies = store.listProxies(user.id);
    const byKind = proxies.reduce((acc, proxy) => {
      const kind = proxy.ip_kind || 'unknown';
      acc[kind] = (acc[kind] || 0) + 1;
      return acc;
    }, {});
    // L'empreinte est calculée sur le profil appliqué au contexte. La version
    // exacte du moteur n'est connue qu'après son lancement : sans navigateur
    // ouvert, on présente le profil type (mêmes réglages, version courante).
    const version = engineVersion;
    const profile = contextProfile(version);
    sendJson(res, 200, {
      fingerprint: fingerprintFromProfile(profile, false),
      proxies: {
        total: proxies.length,
        enabled: proxies.filter((proxy) => proxy.enabled).length,
        datacenter: byKind.datacenter || 0,
        residential: byKind.residential || 0,
        unknown: byKind.unknown || 0,
        priority: (byKind.residential || 0) > 0,
      },
      sessions: store.listTargetSessions(user.id).length,
      rules: {
        ip: (byKind.residential || 0) > 0
          ? 'Au moins un proxy résidentiel connu : il passe en priorité.'
          : 'Aucun proxy résidentiel identifié : lance le test des proxys pour connaître la nature de leurs IP.',
        cookies: store.listTargetSessions(user.id).length
          ? 'Les cookies de chaque cible sont conservés entre les visites.'
          : 'Les cookies seront conservés dès le premier cycle réussi.',
      },
    });
  });

  // Sessions (cookies) conservées par cible : visibles et effaçables, pour que
  // l'utilisateur garde la main sur ce qui est stocké en son nom.
  route('GET', '/api/sessions', (req, res, user) => {
    const sessions = store.listTargetSessions(user.id);
    const byTarget = new Map(store.listTargets(user.id).map((target) => [target.id, target]));
    sendJson(res, 200, {
      sessions: sessions.map((session) => ({
        ...session,
        pseudo: byTarget.get(session.targetId)?.pseudo || 'Cible supprimée',
      })),
    });
  });

  route('DELETE', '/api/sessions', (req, res, user, session, url) => {
    const id = url.searchParams.get('id') || 'all';
    const removed = id === 'all'
      ? store.listTargetSessions(user.id).reduce((sum, item) => sum + store.deleteTargetSession(user.id, item.targetId), 0)
      : store.deleteTargetSession(user.id, id);
    sendJson(res, 200, { removed, message: `${removed} session(s) supprimée(s).` });
  });

  route('POST', '/api/proxies/test', async (req, res, user) => {
    const body = await readJsonBody(req);
    const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
    const targets = ids.length
      ? ids.map((id) => store.getProxyRow(user.id, id)).filter(Boolean)
      : store.listProxies(user.id).filter((proxy) => proxy.enabled).map((proxy) => store.getProxyRow(user.id, proxy.id));
    if (!targets.length) throw new HttpError(400, 'Aucun proxy à tester.');
    const results = [];
    for (const row of targets.slice(0, 25)) {
      const started = Date.now();
      try {
        const entry = decryptProxyRow(row, config.secretKey);
        const probe = await probeProxy(entry, config.proxyTestTimeoutMs);
        store.recordProxyOutcome(row.id, { success: true, disableAfter: 999 });
        // Nature de l'IP de sortie : c'est elle qui décide du sort devant
        // Cloudflare, bien plus que le fournisseur de proxy choisi.
        const exit = await describeExitIp(probe.ip, { timeoutMs: Math.max(2500, config.proxyTestTimeoutMs) });
        // Mémorisé : la rotation privilégiera les proxies résidentiels (règle 1).
        store.setProxyIpInfo(row.user_id, row.id, { ipKind: exit.kind, asn: exit.asn, org: exit.org });
        results.push({
          id: row.id, host: row.host, port: row.port, ok: true,
          latencyMs: Date.now() - started,
          exitIp: exit.ip, ipKind: exit.kind, asn: exit.asn,
          org: exit.org ? String(exit.org).slice(0, 80) : '', provider: exit.provider || '',
        });
      } catch (error) {
        store.recordProxyOutcome(row.id, { success: false, error: error.message, disableAfter: 999 });
        results.push({ id: row.id, host: row.host, port: row.port, ok: false, message: String(error.message).slice(0, 160), latencyMs: Date.now() - started });
      }
    }
    sendJson(res, 200, { results, tested: results.length });
  });

  /* --- serveur --- */
  const server = createServer(async (req, res) => {
    const started = process.hrtime.bigint();
    applySecurityHeaders(res);
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    let user = null;
    let session = null;
    try {
      if (req.method === 'GET' && url.pathname === '/api/cron') {
        throw new HttpError(404, 'Le planificateur interne remplace les tâches cron.');
      }
      const match = routes.find((item) => item.pathname === url.pathname && item.method === req.method);
      if (match) {
        if (match.needsAuth) {
          session = auth.currentSession(req);
          if (!session) throw new HttpError(401, 'Connectez-vous pour continuer.', 'not_authenticated');
          user = session.user;
          store.touchSession(session.id);
        }
        await match.handler(req, res, user, session, url);
      } else if (url.pathname.startsWith('/api/')) {
        const declared = routes.filter((item) => item.pathname === url.pathname);
        if (declared.length) {
          res.setHeader('Allow', declared.map((item) => item.method).join(', '));
          throw new HttpError(405, 'Méthode non autorisée.', 'method_not_allowed');
        }
        throw new HttpError(404, 'Ressource introuvable.');
      } else if (req.method === 'GET' || req.method === 'HEAD') {
        if (!serveStatic(req, res, config.publicDir, url.pathname)) {
          // Repli SPA uniquement pour les routes sans extension : un fichier
          // manquant (.js, .json…) doit rester un 404, pas une page HTML.
          const looksLikeFile = /\.[a-z0-9]{1,8}$/i.test(url.pathname);
          if (!looksLikeFile && serveStatic(req, res, config.publicDir, '/index.html')) {
            // l'application gère la route côté client
          } else {
            sendText(res, 404, 'Fichier introuvable.');
          }
        }
      } else {
        throw new HttpError(405, 'Méthode non autorisée.');
      }
    } catch (error) {
      if (res.headersSent) { res.end(); return; }
      const status = statusOf(error);
      if (status >= 500) logger.error('requête échouée', error?.stack || error);
      // Corps interrompu (413) : le client est encore en train d'envoyer. Sans
      // fermeture explicite, il n'atteint jamais la réponse et reste bloqué.
      if (status === 413) {
        res.setHeader('Connection', 'close');
        sendJson(res, status, { error: error?.message || 'Erreur interne.', code: error?.code || 'error' });
        req.destroy();
        return;
      }
      sendJson(res, status, { error: error?.message || 'Erreur interne.', code: error?.code || 'error' });
    } finally {
      if (config.logLevel === 'debug') {
        const ms = Number(process.hrtime.bigint() - started) / 1e6;
        logger.info(`${req.method} ${url.pathname} ${res.statusCode} ${ms.toFixed(1)}ms`);
      }
    }
  });

  server.on('clientError', (error, socket) => {
    if (!socket.writable) return;
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });

  return { server, worker, scheduler, auth, store };
}

export { clicksAllowedToday, plannedCountForDay, publicVisit, constantTimeEqual };
