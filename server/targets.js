import '../extension/bot-utils.js';
import { HttpError } from './errors.js';
import { normalizeTargetUrl } from './net-safety.js';
import { formatDays } from './time.js';

// Les calculs de rythme viennent de l'extension : une seule implémentation,
// donc un total identique entre le panneau Chrome et le serveur.
const utils = globalThis.InstaVAUtils;

export const MAX_TARGETS = 50;
export const MAX_EXECUTION_TARGET = utils.MAX_TARGET_VISITS;
export const MIN_CLICKS_PER_DAY = utils.MIN_VISITS_PER_DAY;
export const MAX_INTERVAL_DAYS = utils.MAX_INTERVAL_DAYS;
export const MIN_INTERVAL_DAYS = utils.MIN_INTERVAL_DAYS;
export const DEFAULT_DAYS = 7;

/**
 * Le bot « fait au moins 100 clics par jour » : un total trop faible est relevé
 * au minimum quotidien, un total trop élevé reste plafonné par l'écart de 5 min.
 */
export function planTarget({ mode, executionTarget, durationDays }) {
  const days = Math.min(Math.max(Number(durationDays) || DEFAULT_DAYS, MIN_INTERVAL_DAYS), MAX_INTERVAL_DAYS);
  if (mode === 'goal') {
    return {
      mode: 'goal',
      durationDays: 1,
      requested: executionTarget,
      effectiveTotal: executionTarget,
      dailyMinimum: 0,
      dailyQuota: [executionTarget],
      adjusted: false,
      reason: '',
    };
  }
  const fitted = utils.fitVisitsToRate(executionTarget, days);
  const quota = utils.dailyVisitQuota(fitted.count, days);
  return {
    mode: 'interval',
    durationDays: days,
    requested: fitted.requested,
    effectiveTotal: fitted.count,
    dailyMinimum: Math.min(MIN_CLICKS_PER_DAY, fitted.count),
    dailyQuota: quota,
    adjusted: fitted.adjusted,
    reason: fitted.count > fitted.requested
      ? `Relevé à ${fitted.count} clics pour tenir au moins ${MIN_CLICKS_PER_DAY} clics par jour sur ${formatDays(days)}.`
      : fitted.count < fitted.requested
        ? `Ramencé à ${fitted.count} clics : ${fitted.maximum} clics par jour au maximum avec 5 minutes d’écart.`
        : '',
  };
}

export function validateTargetInput(body) {
  const pseudo = String(body.pseudo || '').trim();
  const linkLabel = String(body.linkLabel ?? body.link_label ?? '').trim();
  const mode = String(body.mode || 'interval').toLowerCase();
  const executionTarget = Number(body.executionTarget ?? body.execution_target);
  const durationInput = body.durationDays ?? body.duration_days;

  if (!pseudo || pseudo.length > 60) throw new HttpError(400, 'Le pseudo doit contenir entre 1 et 60 caractères.');
  if (linkLabel.length > 100) throw new HttpError(400, 'Le libellé doit contenir au maximum 100 caractères.');
  if (!['interval', 'goal'].includes(mode)) throw new HttpError(400, 'Mode inconnu : choisissez intervalle ou objectif.');
  if (!Number.isInteger(executionTarget) || executionTarget < 1 || executionTarget > MAX_EXECUTION_TARGET) {
    throw new HttpError(400, `Le nombre de visites doit être un entier entre 1 et ${MAX_EXECUTION_TARGET}.`);
  }
  if (mode === 'interval') {
    const days = Number(durationInput);
    if (!Number.isInteger(days) || days < MIN_INTERVAL_DAYS || days > MAX_INTERVAL_DAYS) {
      throw new HttpError(400, `La durée doit être comprise entre ${MIN_INTERVAL_DAYS} et ${MAX_INTERVAL_DAYS} jours.`);
    }
  }

  const plan = planTarget({ mode, executionTarget, durationDays: mode === 'interval' ? Number(durationInput) : 1 });
  const data = {
    pseudo,
    url: normalizeTargetUrl(body.url),
    link_label: linkLabel,
    mode,
    execution_target: executionTarget,
    duration_days: plan.durationDays,
    // Le total réellement exécuté tient compte du minimum de 100 clics/jour
    // et du plafond de 288 clics/jour imposé par l'écart de 5 minutes.
    effective_total: plan.effectiveTotal,
    daily_minimum: plan.dailyMinimum,
  };
  return { data, plan: { ...plan, description: describePlan(data) } };
}

/** Message lisible décrivant ce que le bot fera réellement pour cette cible. */
export function describePlan(target) {
  const total = Number(target.effective_total ?? target.effectiveTotal);
  const requested = Number(target.execution_target ?? target.executionTarget);
  const days = Number(target.duration_days ?? target.durationDays);
  const minimum = Number(target.daily_minimum ?? target.dailyMinimum);
  const mode = target.mode;
  if (mode === 'goal') {
    return `Objectif : ${requested} clics en une série continue, sans durée.`;
  }
  const parts = [`${days} jour(s)`, `${total} clics au total`];
  if (total > requested) parts.push(`relevé depuis ${requested} pour tenir le minimum quotidien`);
  if (total < requested) parts.push(`ramené depuis ${requested} (maximum ${utils.maxVisitsPerDay()} par jour)`);
  if (minimum) parts.push(`au moins ${minimum} clics/jour`);
  return `Intervalle : ${parts.join(' · ')}.`;
}
