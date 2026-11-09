import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { createAuth } from './auth.js';
import { constantTimeEqual, decryptSecret, encryptSecret, maskValue } from './crypto.js';
import { HttpError, statusOf } from './errors.js';
import { applySecurityHeaders, clientIp, readJsonBody, sendJson, sendText, serveStatic } from './http.js';
import { validateProxyConfiguration } from './net-safety.js';
import { createRateLimiter } from './ratelimit.js';
import { buildVisitSchedule, clicksAllowedToday, plannedCountForDay } from './schedule.js';
import { createScheduler } from './scheduler.js';
import { createStore, publicVisit } from './store.js';
import { describePlan, MAX_TARGETS, planTarget, validateTargetInput } from './targets.js';
import { dayKeyIn } from './time.js';
import { createWorker } from './worker.js';

const loginLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 10 });
const signupLimiter = createRateLimiter({ windowMs: 60 * 60 * 1000, max: 5 });

/**
 * Construit le serveur HTTP complet du bot autonome.
 * `deps` permet d'injecter un faux navigateur dans les tests.
 */
export function createApp({ config, store, logger = console, openBrowser, runCycle, startWorker = true }) {
  const auth = createAuth({ store, config });
  let worker = null;
  let scheduler = null;

  function decryptProxy(userId) {
    const row = store.getProxySettings(userId);
    if (!row) return null;
    const parsed = JSON.parse(decryptSecret(row.secret_box, config.secretKey));
    return { scheme: row.scheme, host: row.host, port: Number(row.port), ...parsed };
  }

  if (openBrowser && runCycle) {
    scheduler = createScheduler({ store, config, log: (message) => logger.info(message) });
    worker = createWorker({
      store, config, scheduler, openBrowser, runCycle, decryptProxy, logger,
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
      worker: worker ? { running: worker.isRunning, active: worker.activeCount } : { running: false, active: 0 },
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
      history: store.dailyClicksByTarget(user.id, target.id, 14),
    }));
    sendJson(res, 200, {
      runs,
      visits,
      today,
      todayTotal: store.dailyClicksForUser(user.id, today),
      clicksByTarget: perTarget,
      stats: store.stats(user.id),
    });
  });

  /* --- proxy --- */
  route('GET', '/api/proxy', (req, res, user) => {
    const row = store.getProxySettings(user.id);
    sendJson(res, 200, {
      configured: Boolean(row),
      scheme: row?.scheme || null,
      host: row?.host || null,
      port: row?.port ? Number(row.port) : null,
      username: row?.username_masked || null,
      updatedAt: row?.updated_at || null,
    });
  });

  route('POST', '/api/proxy', async (req, res, user) => {
    const body = await readJsonBody(req);
    const secret = await validateProxyConfiguration(body);
    store.saveProxySettings(user.id, {
      scheme: secret.scheme,
      host: secret.host,
      port: secret.port,
      username_masked: maskValue(secret.username),
      secret_box: encryptSecret(JSON.stringify({ username: secret.username, password: secret.password }), config.secretKey),
    });
    sendJson(res, 200, { configured: true, message: 'Identifiants chiffrés AES-256-GCM sur le VPS. Ils ne sont jamais renvoyés au navigateur.' });
  });

  route('DELETE', '/api/proxy', (req, res, user) => {
    store.deleteProxySettings(user.id);
    sendJson(res, 200, { configured: false });
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
