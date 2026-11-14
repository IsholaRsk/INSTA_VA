import '../extension/bot-utils.js';
import { DAY_MS, dayKeyIn } from './time.js';

const utils = globalThis.InstaVAUtils;

// Pause entre deux clics d'une même cible : courte. Plus d'écart imposé, plus
// de plafond quotidien (directive utilisateur : « enchaîne les clics »).
export const MIN_GAP_MS = utils.DEFAULT_CHAIN_GAP_MS;
// Conservé pour l'affichage : ce n'est plus un plafond appliqué.
export const MAX_PER_DAY = Infinity;
export const MIN_CLICKS_PER_DAY = utils.MIN_VISITS_PER_DAY;

/**
 * Calendrier complet d'une cible : `effectiveTotal` visites réparties sur
 * `durationDays`, avec l'implémentation testée de l'extension. Les visites
 * d'une même journée s'enchaînent (pause courte), sans plafond quotidien.
 */
export function buildVisitSchedule({ effectiveTotal, durationDays, startAt = Date.now(), random }) {
  // `startAt` est le premier créneau : l'appelant ajoute le délai de démarrage.
  const options = typeof random === 'function' ? { random } : undefined;
  return utils.buildDailyRunTimes(effectiveTotal, durationDays, startAt, options);
}

/**
 * Combien de clics cette cible peut encore exécuter aujourd'hui.
 *
 * Plus de plafond quotidien : tout ce qui reste à faire est autorisé dans la
 * journée. Le quota du jour ne sert plus de limite, seulement le minimum de
 * 100 clics/jour pour relever un total trop faible.
 */
export function clicksAllowedToday({ remaining }) {
  if (remaining <= 0) return 0;
  return remaining;
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
 * Plus d'écart imposé, quel que soit le mode : la série enchaîne. `goalGapMs`
 * (INSTAVA_GOAL_GAP_MS) permet d'ajouter volontairement une pause ; il vaut
 * 0 par défaut, donc l'enchaînement est immédiat.
 */
export function gapForTarget(mode, { random = Math.random, goalGapMs = 0 } = {}) {
  const base = Math.max(0, Number(goalGapMs) || 0);
  if (!base) return 0;
  // Un peu de variation évite une cadence parfaitement mécanique.
  return Math.round(base * (0.75 + random() * 0.5));
}
