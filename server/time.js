import '../extension/bot-utils.js';

// bot-utils.js est un script UMD sans export ESM : l'import l'exécute et il publie
// son API sur globalThis.InstaVAUtils, seule source de vérité pour les calculs.
export const DAY_MS = globalThis.InstaVAUtils.DAY_MS;

const dateFormatterCache = new Map();

function formatterFor(timeZone) {
  const key = timeZone || 'UTC';
  let formatter = dateFormatterCache.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: key, year: 'numeric', month: '2-digit', day: '2-digit',
    });
    dateFormatterCache.set(key, formatter);
  }
  return formatter;
}

/** Clé de journée `YYYY-MM-DD` dans le fuseau du serveur (par défaut Cotonou, UTC+1, sans heure d'été). */
export function dayKeyIn(timeZone, at = Date.now()) {
  const parts = formatterFor(timeZone).formatToParts(new Date(at));
  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  const day = parts.find((part) => part.type === 'day')?.value;
  return `${year}-${month}-${day}`;
}

/** Minuit du lendemain de `day` (clé YYYY-MM-DD) exprimé en timestamp UTC approximatif. */
export function nextDayStart(timeZone, at = Date.now()) {
  return startOfDay(timeZone, at) + DAY_MS;
}

export function startOfDay(timeZone, at = Date.now()) {
  const key = dayKeyIn(timeZone, at);
  return Date.parse(`${key}T00:00:00Z`) - offsetMs(timeZone, at);
}

/** Décalage du fuseau (ms) à l'instant donné : heure locale = UTC + offset. */
export function offsetMs(timeZone, at = Date.now()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(at));
  const pick = (type) => Number(parts.find((part) => part.type === type)?.value || 0);
  const asUtc = Date.UTC(pick('year'), pick('month') - 1, pick('day'), pick('hour'), pick('minute'), pick('second'));
  return asUtc - Math.floor(at / 1000) * 1000;
}

export function toIso(value = Date.now()) {
  return new Date(value).toISOString();
}

/** Formate une durée en jours pour les messages (« 3 jours », « 1 jour »). */
export function formatDays(days) {
  return `${days} jour${Number(days) > 1 ? 's' : ''}`;
}
