/** Petits utilitaires d'affichage partagés par les composants. */

export function formatNumber(value) {
  const n = Math.max(0, Math.floor(Number(value) || 0));
  return n.toLocaleString('fr-FR');
}

/** Date courte « 08/28 » comme sur la capture, ou « — » si absente. */
export function shortDate(iso, now = new Date()) {
  const date = iso ? new Date(iso) : now;
  if (Number.isNaN(date.getTime())) return '—';
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const year = String(date.getFullYear()).slice(-2);
  return `${month}/${year}`;
}

/** « il y a 3 min », « il y a 2 h » — plus parlant qu'un horodatage. */
export function timeAgo(iso, now = Date.now()) {
  const then = Date.parse(iso || '');
  if (!Number.isFinite(then)) return '';
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 60) return `il y a ${seconds} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `il y a ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `il y a ${hours} h`;
  return `il y a ${Math.round(hours / 24)} j`;
}

export function initials(email = '') {
  const clean = String(email).split('@')[0].replace(/[^a-zA-Z0-9]/g, '');
  return (clean.slice(0, 2) || 'IV').toUpperCase();
}
