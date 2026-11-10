import { randomUUID } from 'node:crypto';
import { dayKeyIn } from './time.js';
import { ChallengeError } from './browser.js';

const LAUNCH_ERROR_RE = /Executable doesn\u2019t exist|Executable doesn't exist|Failed to launch|browserType\.launch/i;

// Un refus pare-feu (1020) est une décision du site, pas un incident passager.
// Après ce nombre de refus consécutifs sur une même cible, la série est arrêtée
// au lieu de réessayer jusqu'à 288 fois par jour pour rien.
const HARD_BLOCK_STOP_AFTER = 3;

/**
 * Traduit les erreurs techniques en messages actionnables depuis un téléphone,
 * sans exposer de chemins internes ni de détails du serveur.
 */
export function friendlyCycleError(error) {
  const raw = String(error?.message || 'Échec du cycle.');
  if (error instanceof ChallengeError || error?.name === 'ChallengeError') {
    const status = error.httpStatus ? ` (HTTP ${error.httpStatus})` : '';
    // Blocage pare-feu (erreur 1020) : ce n'est pas un challenge à franchir, la
    // décision est déjà prise. Le conseil « réessaie avec un proxy » serait faux.
    if (error.challenge === 'blocked') {
      return `Le site refuse purement et simplement cette connexion${status} : `
        + 'page Cloudflare « Sorry, you have been blocked », erreur 1020. '
        + 'Ce n’est pas une vérification en cours : rien ne se débloquera en attendant. '
        + 'Les proxies datacenter importés sont dans la même situation que le VPS. '
        + 'Un proxy résidentiel est la seule marge de manœuvre, et certains sites restent inaccessibles malgré cela.';
    }
    return `Le site affiche une page de vérification Cloudflare${status} au lieu de la page réelle : `
      + 'il bloque le navigateur du VPS. Essaie avec un proxy résidentiel Webshare, '
      + 'ou depuis une IP moins exposée.';
  }
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
  onProxyOutcome = () => {},
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

  // Refus consécutifs par cible : un site qui bloque en 1020 ne se débloquera
  // pas en réessayant 288 fois dans la journée.
  const hardBlockStreak = new Map();

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

    // Proxy du cycle : rotation sur la liste activée (aucun si désactivée).
    let proxy = null;
    let proxyId = null;
    try {
      const picked = decryptProxy(visit.user_id);
      if (picked && picked.proxy) { proxy = picked.proxy; proxyId = picked.id; }
    } catch (error) { logger.warn(`Proxy ignoré pour ${target.pseudo} : ${error.message}`); }

    try {
      const browser = await getBrowser();
      let result;
      try {
        result = await runCycle({
          browser,
          url: target.url,
          linkLabel: target.link_label,
          proxy,
          navigationTimeout: config.navigationTimeoutMs,
          challengeWaitMs: config.challengeWaitMs,
        });
      } catch (error) {
        // Blocage anti-bot : sans proxy, on rejoue une fois via la liste de
        // proxys (autre IP) ; avec un proxy, on passe au suivant de la liste.
        const blocked = error instanceof ChallengeError || error?.name === 'ChallengeError';
        if (!blocked) throw error;
        // Un blocage pare-feu (1020) ne dit rien de la qualité du proxy : le
        // site refuse l'accès en bloc. Imputer l'échec au proxy désactiverait
        // toute la liste, y compris des proxys parfaitement sains.
        const hardBlock = error.challenge === 'blocked';
        if (proxyId && !hardBlock) onProxyOutcome(proxyId, visit.user_id, { success: false, error: 'Bloqué par Cloudflare' });
        let fallback = null;
        try { fallback = decryptProxy(visit.user_id); } catch { fallback = null; }
        if (!fallback?.proxy) throw error;
        logger.info(`↻ ${target.pseudo} — blocage, nouvel essai via ${fallback.proxy.host}:${fallback.proxy.port}.`);
        proxy = fallback.proxy;
        proxyId = fallback.id;
        result = await runCycle({
          browser,
          url: target.url,
          linkLabel: target.link_label,
          proxy,
          navigationTimeout: config.navigationTimeoutMs,
          challengeWaitMs: config.challengeWaitMs,
        });
      }
      // Le proxy utilisé est crédité du cycle réussi.
      if (proxyId) onProxyOutcome(proxyId, visit.user_id, { success: true });
      store.finishVisit(visit.id, 'success', result);
      // Le clic réussi alimente le journal quotidien (quota de 100 clics/jour).
      store.addClick(visit.user_id, target.id, dayKeyIn(config.timeZone), 1);
      // L'IP de sortie est journalisée : c'est la preuve visible que le proxy
      // choisi sert vraiment, et non l'IP du VPS.
      const via = proxy ? `via ${proxy.host}${result.exit_ip ? ` (IP ${result.exit_ip})` : ''}` : 'en direct (IP du VPS)';
      logger.info(`✓ ${target.pseudo} — ${result.click_kind} « ${result.click_label} » → ${String(result.final_url).slice(0, 90)} · ${via}`);
    } catch (error) {
      const message = friendlyCycleError(error);
      store.finishVisit(visit.id, 'failed', { message });
      logger.warn(`✗ ${target.pseudo} — ${message}`);

      const refused = (error instanceof ChallengeError || error?.name === 'ChallengeError')
        && error.challenge === 'blocked';
      if (refused) {
        const streak = (hardBlockStreak.get(visit.target_id) || 0) + 1;
        hardBlockStreak.set(visit.target_id, streak);
        if (streak >= HARD_BLOCK_STOP_AFTER) {
          // Inutile de consommer le quota : on arrête la série et on le dit.
          const cancelled = store.cancelPendingVisits(visit.user_id, visit.run_id);
          hardBlockStreak.delete(visit.target_id);
          logger.warn(`■ ${target.pseudo} — refus répété (${streak} fois) : série arrêtée, ${cancelled} visite(s) annulée(s).`);
        }
      } else if (!(error instanceof ChallengeError || error?.name === 'ChallengeError')) {
        hardBlockStreak.delete(visit.target_id);
      }
      // Seules les erreurs réseau/anti-bot sont imputées au proxy ; une erreur
      // de sélection (libellé introuvable) ou un refus global du site (1020)
      // ne disent rien de sa qualité.
      const siteRefused = error instanceof ChallengeError || error?.name === 'ChallengeError'
        ? error.challenge === 'blocked'
        : false;
      if (proxyId && !siteRefused && !/Aucun lien|Plusieurs éléments|page a changé/i.test(message)) {
        onProxyOutcome(proxyId, visit.user_id, { success: false, error: message });
      }
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
