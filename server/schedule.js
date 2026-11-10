import '../extension/bot-utils.js';
import { DAY_MS, dayKeyIn } from './time.js';

const utils = globalThis.InstaVAUtils;

export const MIN_GAP_MS = 5 * 60 * 1000;
export const MAX_PER_DAY = utils.maxVisitsPerDay(MIN_GAP_MS);
export const MIN_CLICKS_PER_DAY = utils.MIN_VISITS_PER_DAY;

/**
 * Calendrier complet d'une cible : `effectiveTotal` visites réparties sur
 * `durationDays`, avec l'implémentation testée de l'extension (écart minimal de
 * 5 minutes, maximum 288 par jour, surplus reporté sur les jours suivants).
 */
export function buildVisitSchedule({ effectiveTotal, durationDays, startAt = Date.now(), random }) {
  // `startAt` est le premier créneau : l'appelant ajoute le délai de démarrage.
  const options = typeof random === 'function' ? { random } : undefined;
  return utils.buildDailyRunTimes(effectiveTotal, durationDays, startAt, options);
}

/**
 * Combien de clics cette cible peut encore exécuter aujourd'hui.
 *
 * Règles :
 *  - objectif : `remaining` (série continue, pas de plafond quotidien) ;
 *  - intervalle : maximum entre le quota du jour et 100, plus le rattrapage
 *    (plafonné à 100 clics de retard), le tout borné à 288 clics/jour.
 */
export function clicksAllowedToday({ mode, plannedToday, doneToday, backlog = 0, remaining, minimum = MIN_CLICKS_PER_DAY }) {
  if (remaining <= 0) return 0;
  if (mode === 'goal') return remaining;
  const floor = Math.min(Math.max(minimum, 0), remaining);
  const catchUp = Math.min(Math.max(backlog, 0), MIN_CLICKS_PER_DAY);
  const wanted = Math.max(Math.max(plannedToday, 0), floor) + catchUp;
  const hardCap = Math.min(MAX_PER_DAY, remaining + doneToday);
  return Math.max(0, Math.min(wanted, hardCap) - doneToday);
}

/**
 * Nombre de visites calendaires d'une cible prévues pour une journée donnée.
 * Sert de « quota du jour » au contrôle ci-dessus.
 */
export function plannedCountForDay(scheduledAts, timeZone, day) {
  let total = 0;
  for (const value of scheduledAts) {
    if (dayKeyIn(timeZone, Date.parse(value)) === day) total += 1;
  }
  return total;
}

export { DAY_MS, dayKeyIn };

/**
 * Écart entre deux clics d'une même cible.
 *
 * Mode intervalle : 5 minutes, c'est la règle du calendrier.
 * Mode objectif : la série s'enchaîne. L'écart est réglable
 * (INSTAVA_GOAL_GAP_MS) ; il vaut 0 par défaut, donc l'enchaînement est
 * immédiat — la boucle du bot n'ajoute aucune attente de son côté.
 */
export function gapForTarget(mode, { random = Math.random, goalGapMs = 0 } = {}) {
  if (mode !== 'goal') return MIN_GAP_MS;
  const base = Math.max(0, Number(goalGapMs) || 0);
  if (!base) return 0;
  // Un peu de variation évite une cadence parfaitement mécanique.
  return Math.round(base * (0.75 + random() * 0.5));
}
