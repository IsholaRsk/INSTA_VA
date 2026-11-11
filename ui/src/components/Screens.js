import { h } from '../lib.js';
import { earningsBreakdown, earningsForClicks, formatMoney, rateForTier, CLICKS_PER_TIER, TIER_RATE_START, BONUS_TIERS, TIER_RATE_AFTER_BONUS } from '../domain/earnings.js';
import { formatNumber } from '../domain/format.js';
import { IconBolt, IconGlobe, IconUser } from './icons.js';

const card = (children) => h('section', { className: 'section' }, children);
const row = (key, label, value) => h('div', { key, className: 'row-item' },
  h('div', { className: 'row-main' },
    h('strong', null, label),
    h('small', null, value),
  ),
);

/** Onglet « Clics » : le barème complet, en clair, et le détail par cible. */
export function ClicksScreen({ clicksTotal = 0, targets = [], todayTotal = 0 } = {}) {
  const detail = earningsBreakdown(clicksTotal);
  const paliers = [1, 2, 3, 4].map((tier) => {
    const rate = rateForTier(tier);
    const target = tier * CLICKS_PER_TIER;
    return row(
      `tier-${tier}`,
      `${formatNumber((tier - 1) * CLICKS_PER_TIER + 1)} – ${formatNumber(target)} clics`,
      `${formatMoney(rate)} par tranche${tier <= BONUS_TIERS ? ' (tarif de départ)' : ' (tarif réduit)'}`,
    );
  });

  return h('div', { className: 'secondary', style: { display: 'flex', flexDirection: 'column', gap: '16px' } },
    card([
      h('div', { className: 'section-head', key: 'head' },
        h('h2', null, 'Ton barème'),
        h('span', { className: 'badge good' }, formatMoney(detail.earned)),
      ),
      h('p', { className: 'empty', key: 'copy', style: { textAlign: 'left', padding: '0 0 12px' } },
        `${TIER_RATE_START} $ par tranche de ${CLICKS_PER_TIER} clics, pendant les ${BONUS_TIERS} premières tranches. `
        + `Ensuite ${TIER_RATE_AFTER_BONUS} $ par tranche. Aujourd’hui : ${formatNumber(todayTotal)} clic(s).`),
      h('div', { className: 'row-list', key: 'rows' }, paliers),
    ]),

    card([
      h('div', { className: 'section-head', key: 'head' }, h('h2', null, 'Où en est le solde')),
      h('div', { className: 'row-list', key: 'rows' },
        row('total', 'Total de clics', `${formatNumber(detail.clicks)} clics`),
        row('tiers', 'Tranches complétées', `${detail.tiers}`),
        row('earned', 'Acquis', formatMoney(detail.earned)),
        row('next', 'Prochaine tranche', `${formatMoney(detail.nextTierRate)} à ${formatNumber(detail.nextTierTarget)} clics`),
        row('remain', 'Encore', `${formatNumber(detail.remainingInTier)} clics`),
      ),
    ]),

    card([
      h('div', { className: 'section-head', key: 'head' }, h('h2', null, 'Détail par cible')),
      targets.length
        ? h('div', { className: 'row-list', key: 'rows' },
          targets.map((target) => row(
            target.target_id,
            target.pseudo || 'Cible',
            `${formatNumber(target.today || 0)} aujourd’hui · ${formatNumber(target.clicksTotal || 0)} au total`,
          )),
        )
        : h('p', { className: 'empty', key: 'empty' }, 'Aucune cible enregistrée.'),
    ]),
  );
}

/** Onglet « Bot » : état du moteur et des cibles. */
export function BotScreen({ worker = null, targets = [], onLaunch = null, busy = false } = {}) {
  const running = Boolean(worker?.running);
  return h('div', { className: 'secondary', style: { display: 'flex', flexDirection: 'column', gap: '16px' } },
    card([
      h('div', { className: 'section-head', key: 'head' },
        h('h2', null, 'Moteur'),
        h('span', { className: `badge ${running ? 'good' : 'warn'}` }, running ? 'en marche' : 'à l’arrêt'),
      ),
      h('div', { className: 'row-list', key: 'rows' },
        row('active', 'Cycles en cours', `${Number(worker?.active || 0)}`),
        row('restarts', 'Fenêtres relancées', `${Number(worker?.restarts || 0)}`),
        row('blocked', 'Blocages traversés', `${Number(worker?.blockedVisits || 0)}`),
        row('failed', 'Visites échouées', `${Number(worker?.failedVisits || 0)}`),
      ),
    ]),

    card([
      h('div', { className: 'section-head', key: 'head' }, h('h2', null, 'Cibles actives')),
      targets.length
        ? h('div', { className: 'row-list', key: 'rows' },
          targets.map((target) => h('div', { key: target.id, className: 'row-item' },
            h('span', { className: 'row-icon' }, h(target.mode === 'goal' ? IconBolt : IconGlobe)),
            h('div', { className: 'row-main' },
              h('strong', null, target.pseudo || 'Cible'),
              h('small', null, target.url ? String(target.url).slice(0, 46) : ''),
            ),
            h('span', { className: 'badge' }, target.mode === 'goal' ? 'objectif' : 'intervalle'),
          )),
        )
        : h('p', { className: 'empty', key: 'empty' }, 'Aucune cible. Ajoute-en une depuis l’ancien tableau de bord.'),
      onLaunch && h('button', {
        key: 'launch',
        type: 'button',
        disabled: busy || !targets.length,
        onClick: onLaunch,
        style: {
          marginTop: '14px', width: '100%', border: 0, borderRadius: '14px', padding: '14px',
          background: 'linear-gradient(150deg, var(--violet-soft), var(--violet-deep))',
          color: '#fff', fontWeight: 700, fontSize: '13px', cursor: busy ? 'not-allowed' : 'pointer',
          opacity: busy || !targets.length ? .55 : 1,
        },
      }, busy ? 'Lancement…' : 'Lancer toutes les cibles'),
    ]),
  );
}

/** Onglet « Compte ». */
export function AccountScreen({ user = null, onSignOut = null, server = null } = {}) {
  return h('div', { className: 'secondary', style: { display: 'flex', flexDirection: 'column', gap: '16px' } },
    card([
      h('div', { className: 'section-head', key: 'head' }, h('h2', null, 'Compte')),
      h('div', { className: 'row-list', key: 'rows' },
        h('div', { className: 'row-item', key: 'email' },
          h('span', { className: 'row-icon' }, h(IconUser)),
          h('div', { className: 'row-main' },
            h('strong', null, String(user?.email || '—').split('@')[0]),
            h('small', null, user?.email || ''),
          ),
          h('span', { className: 'badge' }, user?.role || 'membre'),
        ),
        row('version', 'Version du serveur', `InstaVA ${server?.version || '—'}`),
        row('tz', 'Fuseau des quotas', server?.timeZone || '—'),
      ),
      onSignOut && h('button', {
        key: 'out',
        type: 'button',
        onClick: onSignOut,
        style: {
          marginTop: '14px', width: '100%', borderRadius: '14px', padding: '13px',
          background: 'var(--surface-2)', border: '1px solid var(--line-strong)',
          color: 'var(--text)', fontWeight: 600, fontSize: '12.5px', cursor: 'pointer',
        },
      }, 'Se déconnecter'),
    ]),
  );
}
