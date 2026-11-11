import { h } from '../lib.js';
import { earningsBreakdown, formatMoney, CLICKS_PER_TIER } from '../domain/earnings.js';
import { formatNumber, shortDate } from '../domain/format.js';
import { IconTopUp } from './icons.js';

/**
 * La carte principale : le solde, qui augmente avec les clics.
 * La carte jaune derrière rappelle la seconde carte de la capture.
 */
export function BalanceCard({ clicks = 0, user = null, onTopUp = null, now } = {}) {
  const detail = earningsBreakdown(clicks);
  const number = `•••• •••• •••• ${String(4821).padStart(4, '0')}`;
  return h('div', { className: 'card-stack' },
    h('div', { className: 'mini-card', 'aria-hidden': 'true' },
      h('div', null,
        h('div', null, number),
        h('div', { className: 'mini-label' }, 'Carte de réserve'),
      ),
      h('div', { className: 'brand-mark' }, 'IV'),
    ),
    h('div', { className: 'balance-card' },
      h('div', { className: 'balance-head' },
        h('div', { className: 'card-brand' },
          h('span', { 'aria-hidden': 'true' }, '◈'),
          h('span', null, 'InstaVA'),
        ),
        h('div', { className: 'card-number' }, number),
      ),
      h('div', { className: 'balance-body' },
        h('div', null,
          h('p', { className: 'balance-label' }, 'Solde'),
          h('p', { className: 'balance-amount' }, formatMoney(detail.earned)),
        ),
        h('div', { style: { textAlign: 'right' } },
          h('p', { className: 'balance-meta' }, 'Validé le'),
          h('p', { className: 'balance-meta-value' }, shortDate(null, now)),
        ),
      ),
      h('div', { className: 'tier' },
        h('div', { className: 'tier-labels' },
          h('span', null, `${formatNumber(detail.inTier)} / ${CLICKS_PER_TIER} clics`),
          h('span', null, `+${formatMoney(detail.nextTierRate)} à ${formatNumber(detail.nextTierTarget)} clics`),
        ),
        h('div', {
          className: 'tier-track',
          role: 'progressbar',
          'aria-valuemin': 0,
          'aria-valuemax': CLICKS_PER_TIER,
          'aria-valuenow': detail.inTier,
          'aria-label': `Progression vers la prochaine tranche : ${detail.inTier} clics sur ${CLICKS_PER_TIER}`,
        },
          h('div', { className: 'tier-fill', style: { width: `${Math.round(detail.progress * 100)}%` } }),
        ),
      ),
      h('div', { className: 'balance-foot' },
        h('div', null,
          h('p', { className: 'balance-meta' }, 'Titulaire'),
          h('p', { className: 'balance-meta-value' }, user?.email ? String(user.email).split('@')[0] : 'Compte InstaVA'),
        ),
        h('button', {
          className: 'add-button',
          type: 'button',
          onClick: onTopUp || undefined,
          disabled: !onTopUp,
          title: onTopUp ? 'Ajouter des clics' : 'Disponible après connexion',
        },
          h('span', { className: 'plus', 'aria-hidden': 'true' }, '+'),
          h('span', null, 'Ajouter des clics'),
        ),
      ),
    ),
  );
}

/** Détail du barème, réutilisé sur l'écran d'accueil et dans l'onglet Gains. */
export function earningsLines(clicks) {
  const detail = earningsBreakdown(clicks);
  return [
    { label: 'Tranches complétées', value: `${detail.tiers} × 250 clics` },
    { label: 'Déjà acquis', value: formatMoney(detail.earned) },
    { label: 'Prochaine tranche', value: `${formatMoney(detail.nextTierRate)} à ${formatNumber(detail.nextTierTarget)} clics` },
    { label: 'Encore', value: `${formatNumber(detail.remainingInTier)} clics` },
  ];
}
