import { clicksAllowedToday, gapForTarget } from './schedule.js';

/**
 * Sélection des visites à exécuter maintenant.
 *
 * Le calendrier fixe les horaires ; cette couche décide laquelle des visites
 * dues part maintenant. Aucun plafond quotidien : une visite due est exécutable
 * immédiatement, la série enchaîne ses clics.
 */
export function createScheduler({ store, config, log = () => {} }) {
  const lastCycleAt = new Map();

  function markCycleDone(targetId, at = Date.now()) {
    lastCycleAt.set(targetId, at);
  }

  /** Vérifie qu'une visite porte bien tous les champs attendus par le worker. */
  function assertRunnable(visit) {
    for (const field of ['id', 'run_id', 'user_id', 'target_id']) {
      if (!visit?.[field]) throw new Error(`Visite incomplète : ${field} manquant.`);
    }
    return visit;
  }

  function targetProgress(targetId) {
    const row = store.raw.prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END), 0) AS done,
        COALESCE(SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END), 0) AS pending
      FROM visits WHERE target_id = ?`).get(targetId);
    return { done: Number(row?.done || 0), pending: Number(row?.pending || 0) };
  }

  /** Visite exécutable pour un propriétaire, ou null. */
  function nextRunnable(userId, now = Date.now()) {
    const due = store.raw.prepare(`
      SELECT v.id, v.run_id, v.user_id, v.target_id, v.scheduled_at, v.approved_at,
             t.mode, t.execution_target, t.effective_total, t.daily_minimum,
             r.confirm_clicks
      FROM visits v
      JOIN targets t ON t.id = v.target_id
      JOIN runs r ON r.id = v.run_id
      WHERE v.user_id = ? AND v.status = 'pending' AND v.scheduled_at <= ?
        AND v.target_id NOT IN (
          SELECT target_id FROM visits WHERE user_id = ? AND status IN ('running','approval_required')
        )
      ORDER BY v.scheduled_at ASC
      LIMIT 60`).all(userId, new Date(now).toISOString(), userId);

    for (const visit of due) {
      // Pause éventuelle entre deux clics (0 par défaut : la série enchaîne).
      const gap = gapForTarget(visit.mode, { goalGapMs: config.goalGapMs });
      if (now - (lastCycleAt.get(visit.target_id) || 0) < gap) continue;

      const { done } = targetProgress(visit.target_id);
      const totalTarget = visit.mode === 'goal' ? Number(visit.execution_target) : Number(visit.effective_total);
      const remaining = Math.max(0, totalTarget - done);
      if (!remaining) continue;

      // Plus de plafond quotidien : seule l'échéance du prochain créneau compte.
      const allowance = clicksAllowedToday({ remaining });
      if (allowance <= 0) continue;

      // Déjà en attente de confirmation : ne pas réclamer la même visite en boucle.
      if (visit.approved_at === null && Number(visit.confirm_clicks) === 1) continue;
      return assertRunnable(visit);
    }
    return null;
  }

  function ownersWithWork(now = Date.now()) {
    return store.raw.prepare(
      "SELECT DISTINCT user_id FROM visits WHERE status = 'pending' AND scheduled_at <= ?",
    ).all(new Date(now).toISOString()).map((row) => row.user_id);
  }

  return { nextRunnable, ownersWithWork, markCycleDone, targetProgress };
}
