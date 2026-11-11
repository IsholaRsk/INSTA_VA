import { h } from '../lib.js';
import { IconHome, IconCard, IconBolt, IconUser } from './icons.js';

const TABS = [
  { id: 'home', label: 'Accueil', icon: IconHome },
  { id: 'clicks', label: 'Clics', icon: IconCard },
  { id: 'bot', label: 'Bot', icon: IconBolt },
  { id: 'account', label: 'Compte', icon: IconUser },
];

/** Barre flottante du bas : l'onglet actif est sur fond blanc, comme la capture. */
export function TabBar({ active = 'home', onChange = null } = {}) {
  return h('nav', { className: 'tabbar', 'aria-label': 'Navigation principale' },
    TABS.map(({ id, label, icon: Icon }) =>
      h('button', {
        key: id,
        type: 'button',
        className: `tab${active === id ? ' active' : ''}`,
        onClick: onChange ? () => onChange(id) : undefined,
        'aria-current': active === id ? 'page' : undefined,
      },
        h(Icon),
        h('span', null, label),
      ),
    ),
  );
}

export { TABS };
