import { h } from '../lib.js';
import { formatNumber, timeAgo } from '../domain/format.js';
import { earningsForClicks } from '../domain/earnings.js';
import { IconHouse, IconGlobe } from './icons.js';

const STATUS_LABELS = {
  success: 'réussi',
  failed: 'échoué',
  running: 'en cours',
  pending: 'en attente',
  approval_required: 'à confirmer',
  cancelled: 'annulé',
};

const STATUS_TONE = {
  success: 'good',
  failed: 'bad',
  approval_required: 'warn',
};

/**
 * Section « clics par cible » : le pendant des dépenses de la capture, mais
 * chaque ligne rapporte au lieu de coûter.
 */
export function ClicksByTarget({ targets = [], onViewAll = null } = {}) {
  const rows = targets.filter((target) => Number(target.today) > 0 || Number(target.clicksTotal) > 0).slice(0, 4);
  return h('section', { className: 'section' },
    h('div', { className: 'section-head' },
      h('h2', null, 'Clics par cible'),
      h('button', { className: 'link', type: 'button', onClick: onViewAll || undefined, disabled: !onViewAll }, 'Tout voir'),
    ),
    rows.length
      ? h('div', { className: 'row-list' },
        rows.map((target) => {
          const today = Number(target.today) || 0;
          return h('div', { key: target.target_id || target.pseudo, className: 'row-item' },
            h('span', { className: 'row-icon' }, h(today ? IconHouse : IconGlobe)),
            h('div', { className: 'row-main' },
              h('strong', null, target.pseudo || 'Cible'),
              h('small', null, `${formatNumber(today)} clic(s) aujourd’hui · ${formatNumber(target.clicksTotal || 0)} au total`),
            ),
            h('span', { className: 'row-amount' }, `${formatNumber(today)} clic(s)`),
          );
        }),
      )
      : h('p', { className: 'empty' }, 'Aucun clic enregistré pour l’instant. Lance une série pour voir le solde monter.'),
  );
}

/** Fil des derniers cycles, avec leur état lisible. */
export function RecentActivity({ visits = [], now = Date.now() } = {}) {
  const recent = visits.slice(0, 5);
  return h('section', { className: 'section' },
    h('div', { className: 'section-head' }, h('h2', null, 'Activité récente')),
    recent.length
      ? h('div', { className: 'row-list' },
        recent.map((visit) => {
          const tone = STATUS_TONE[visit.status] || '';
          const message = visit.result?.message || visit.result?.click_label || '';
          return h('div', { key: visit.id, className: 'row-item' },
            h('span', { className: 'row-icon' }, h(IconGlobe)),
            h('div', { className: 'row-main' },
              h('strong', null, visit.pseudo_snapshot || 'Cible'),
              h('small', null, message ? String(message).slice(0, 70) : (STATUS_LABELS[visit.status] || visit.status)),
            ),
            h('span', { className: `badge ${tone}` }, STATUS_LABELS[visit.status] || visit.status),
            h('span', { className: 'row-amount muted' }, timeAgo(visit.completed_at || visit.scheduled_at, now)),
          );
        }),
      )
      : h('p', { className: 'empty' }, 'Aucun cycle lancé.'),
  );
}
