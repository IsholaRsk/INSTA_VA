import { h } from '../lib.js';
import { IconSend, IconCheck, IconTopUp, IconMore } from './icons.js';

/**
 * Les quatre actions rapides sous la carte, comme sur la capture. Les intitulés
 * sont en français et décrivent des actions réelles de l'application.
 */
export function QuickActions({ onRun = null, onRefresh = null, onProxies = null, onMore = null, busy = false } = {}) {
  const actions = [
    { key: 'run', label: 'Lancer', icon: IconSend, onClick: onRun },
    { key: 'refresh', label: 'Actualiser', icon: IconCheck, onClick: onRefresh },
    { key: 'proxies', label: 'Proxys', icon: IconTopUp, onClick: onProxies },
    { key: 'more', label: 'Plus', icon: IconMore, onClick: onMore },
  ];
  return h('div', { className: 'quick-actions' },
    actions.map(({ key, label, icon: Icon, onClick }) =>
      h('button', {
        key,
        type: 'button',
        className: 'quick-action',
        onClick: onClick || undefined,
        disabled: busy || !onClick,
        title: onClick ? label : 'Non disponible pour le moment',
      },
        h('span', { className: 'ring' }, h(Icon)),
        h('strong', null, label),
      ),
    ),
  );
}
