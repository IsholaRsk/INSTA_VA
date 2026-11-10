import { randomUUID } from 'node:crypto';
import { dayKeyIn } from './time.js';

const LAUNCH_ERROR_RE = /Executable doesn\u2019t exist|Executable doesn't exist|Failed to launch|browserType\.launch/i;

/**
 * Traduit les erreurs techniques en messages actionnables depuis un téléphone,
 * sans exposer de chemins internes ni de détails du serveur.
 */
export function friendlyCycleError(error) {
  const raw = String(error?.message || 'Échec du cycle.');
  if (LAUNCH_ERROR_RE.test(raw)) {
    return 'Chromium n’est pas installé ou ne démarre pas sur le VPS. Lancez « npx playwright install --with-deps chromium » (ou reconstruisez l’image Docker).';
  }
  if (/Timeout .*exceeded|Timeout \d+ms exceeded|net::ERR|NS_ERROR/i.test(raw)) {
    return 'La page n’a pas répondu à temps. Vérifiez l’URL, le proxy, ou augmentez INSTAVA_NAVIGATION_TIMEOUT_MS.';
  }
  if (/Target page, context or browser has been closed/i.test(raw)) {
    return 'Le navigateur a été fermé pendant le cycle. Le prochain essai reprendra normalement.';
  }
  // Un message métier (libellé introuvable, ambigu…) est déjà rédigé pour l’utilisateur.
  return raw.replace(/https?:\/\/[^\s]+/gi, '[URL]').slice(0, 240);
}

/**
 * Boucle d'exécution du bot.
 *
 * Toutes les `tickMs`, elle demande au planificateur la prochaine visite
 * exécutable de chaque propriétaire, puis lance au plus `maxConcurrentCycles`
 * cycles en parallèle. Un seul navigateur est réutilisé pour tous les cycles :
 * chaque cycle ouvre son contexte (proxy, viewport) et le referme.
 */
export function createWorker({
  store,
  config,
  scheduler,
  openBrowser,
  runCycle,
  decryptProxy,
  logger = console,
  onChange = () => {},
}) {
  let starting = false;
  let running = false;
  let timer = null;
  let browserPromise = null;
  const active = new Map();
  let iterations = 0;

  async function getBrowser() {
    if (!browserPromise) {
      browserPromise = openBrowser({ chromiumPath: config.chromiumPath, headless: config.headless })
        .catch((error) => {
          browserPromise = null;
          throw error;
        });
    }
    return browserPromise;
  }

  function refreshRunStatus(runId) {
    const counts = store.raw.prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN status IN ('pending','running','approval_required') THEN 1 ELSE 0 END), 0) AS open,
        COALESCE(SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END), 0) AS live,
        COALESCE(SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END), 0) AS cancelled,
        COUNT(*) AS total
      FROM visits WHERE run_id = ?`).get(runId);
    const open = Number(counts?.open || 0);
    const total = Number(counts?.total || 0);
    const cancelled = Number(counts?.cancelled || 0);
    let status = 'completed';
    if (open > 0) status = Number(counts?.live || 0) > 0 ? 'running' : 'scheduled';
    else if (total > 0 && cancelled === total) status = 'stopped';
    store.setRunStatus(runId, status, open > 0 ? null : new Date().toISOString());
    onChange({ runId, status });
  }

  async function execute(visit) {
    const target = store.raw.prepare('SELECT * FROM targets WHERE id = ?').get(visit.target_id);
    const run = store.raw.prepare('SELECT * FROM runs WHERE id = ?').get(visit.run_id);
    if (!target || !run) {
      store.finishVisit(visit.id, 'failed', { message: 'La cible ou la session n’existe plus.' });
      scheduler.markCycleDone(visit.target_id);
      refreshRunStatus(visit.run_id);
      return;
    }

    const sensitive = isSensitiveLabel(target.link_label);
    if ((run.confirm_clicks || sensitive) && !visit.approved_at) {
      const message = run.confirm_clicks
        ? 'Une confirmation est requise avant ce clic depuis votre téléphone.'
        : `Le libellé « ${String(target.link_label).slice(0, 100)} » peut déclencher une action sensible. Confirmez avant le clic.`;
      store.markVisitApproval(visit.id, message);
      refreshRunStatus(visit.run_id);
      return;
    }

    let proxy = null;
    try { proxy = decryptProxy(visit.user_id); }
    catch (error) { logger.warn(`Proxy ignoré pour ${target.pseudo} : ${error.message}`); }

    try {
      const browser = await getBrowser();
      const result = await runCycle({
        browser,
        url: target.url,
        linkLabel: target.link_label,
        proxy,
        navigationTimeout: config.navigationTimeoutMs,
      });
      store.finishVisit(visit.id, 'success', result);
      // Le clic réussi alimente le journal quotidien (quota de 100 clics/jour).
      store.addClick(visit.user_id, target.id, dayKeyIn(config.timeZone), 1);
      logger.info(`✓ ${target.pseudo} — ${result.click_kind} « ${result.click_label} » → ${String(result.final_url).slice(0, 90)}`);
    } catch (error) {
      const message = friendlyCycleError(error);
      store.finishVisit(visit.id, 'failed', { message });
      logger.warn(`✗ ${target.pseudo} — ${message}`);
      if (LAUNCH_ERROR_RE.test(message)) {
        const instance = await browserPromise?.catch(() => null);
        if (instance) await instance.close().catch(() => {});
        browserPromise = null;
      }
    } finally {
      // Le délai de 5 minutes s'applique même après un échec : pas de rafale.
      scheduler.markCycleDone(visit.target_id);
      refreshRunStatus(visit.run_id);
      onChange({ visitId: visit.id, status: 'done' });
    }
  }

  async function tick() {
    iterations += 1;
    if (iterations % 120 === 1) {
      const purged = store.purgeExpiredSessions();
      const limit = new Date(Date.now() - 40 * 24 * 3600 * 1000).toISOString().slice(0, 10);
      store.pruneClicksBefore(limit);
      if (purged) logger.info(`Sessions expirées supprimées : ${purged}`);
    }
    const slots = config.maxConcurrentCycles - active.size;
    if (slots <= 0) return;
    let launched = 0;
    for (const userId of scheduler.ownersWithWork()) {
      if (launched >= slots) break;
      const visit = scheduler.nextRunnable(userId);
      if (!visit) continue;
      if (!store.markVisitRunning(visit.id)) continue;
      const jobId = randomUUID();
      active.set(jobId, visit.id);
      launched += 1;
      execute(visit)
        .catch((error) => logger.error('cycle échoué', error?.message))
        .finally(() => {
          active.delete(jobId);
          onChange({ type: 'free' });
        });
    }
  }

  async function loop() {
    if (!running) return;
    try { await tick(); }
    catch (error) { logger.error('tick échoué', error?.message || error); }
    if (running) timer = setTimeout(loop, config.tickMs);
  }

  return {
    start() {
      if (starting || running) return;
      starting = true;
      running = true;
      loop().finally(() => { starting = false; });
      logger.info(`Bot démarré : ${config.maxConcurrentCycles} cycle(s) en parallèle, minimum 100 clics/jour par cible.`);
    },
    async stop() {
      running = false;
      if (timer) clearTimeout(timer);
      timer = null;
      const instance = await browserPromise?.catch(() => null);
      browserPromise = null;
      if (instance) await instance.close().catch(() => {});
    },
    /** Réveille la boucle tout de suite (confirmation, nouveau lancement). */
    wake() {
      if (!running) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(loop, 250);
    },
    get activeCount() { return active.size; },
    get isRunning() { return running; },
    refreshRunStatus,
    approve(userId, visitId) {
      const visit = store.getVisit(userId, visitId);
      if (!visit) return null;
      if (visit.status !== 'approval_required') return visit;
      store.approveVisit(visitId);
      refreshRunStatus(visit.run_id);
      this.wake();
      return store.getVisit(userId, visitId);
    },
  };
}

const SENSITIVE_PATTERNS = [
  /\b(?:login|log in|sign in|connexion|se connecter|connecter|s?identifier)\b/,
  /\b(?:sign up|register|inscription|creer un compte|ouvrir un compte)\b/,
  /\b(?:buy|purchase|checkout|payer|paiement|commander|acheter|subscribe|abonnement)\b/,
  /\b(?:delete|supprimer|desactiver|logout|deconnexion|log out)\b/,
  /\b(?:confirm|confirmer|valider|submit|envoyer|send|continuer|publish|publier|post|poster|follow|suivre|like|aimer|comment|commenter)\b/,
  /\b(?:password|mot de passe|otp|code|verification|verify|2fa|authentification)\b/,
];

/** Mêmes libellés sensibles que l'extension (valeurs normalisées, sans accents). */
export function isSensitiveLabel(label) {
  const normalized = String(label || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  return SENSITIVE_PATTERNS.some((pattern) => pattern.test(normalized));
}
