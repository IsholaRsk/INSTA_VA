import { h } from '../lib.js';

/**
 * Icônes en SVG, dessinées en JS plutôt qu'importées : la CSP du serveur
 * n'autorise que 'self', et un tracé inline évite toute requête réseau.
 *
 * Chaque icône renvoie un véritable élément React (via `h`) : un objet
 * littéral { type, props } serait refusé par React avec l'erreur #31.
 */
const svg = (draw) => function Icon(props = {}) {
  const { key = null, ...rest } = props;
  return h('svg', {
    key,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': 'true',
    ...rest,
  }, ...draw.map((d, index) => h(d.tag, { key: index, ...d.attrs })));
};

const path = (d) => ({ tag: 'path', attrs: { d } });
const circle = (cx, cy, r) => ({ tag: 'circle', attrs: { cx, cy, r } });
const rect = (attrs) => ({ tag: 'rect', attrs });

export const IconMenu = svg([path('M4 7h16'), path('M4 12h11'), path('M4 17h16')]);
export const IconBell = svg([
  path('M18 8a6 6 0 1 0-12 0c0 6-2 7-2 7h16s-2-1-2-7'),
  path('M10.3 20a2 2 0 0 0 3.4 0'),
]);
export const IconHome = svg([path('M4 10.5 12 4l8 6.5V19a1 1 0 0 1-1 1h-4v-5H9v5H5a1 1 0 0 1-1-1z')]);
export const IconCard = svg([rect({ x: 3, y: 6, width: 18, height: 12, rx: 2.5 }), path('M3 10.5h18')]);
export const IconUser = svg([
  circle(12, 8.5, 3.5),
  path('M5 20c0-3.6 3.1-5.5 7-5.5s7 1.9 7 5.5'),
]);
export const IconSend = svg([path('M21 3 10.5 13.5'), path('M21 3l-6.5 18-4-8.5L2 8.5z')]);
export const IconCheck = svg([path('M5 12.5 9.5 17 19 7')]);
export const IconTopUp = svg([path('M12 5v14'), path('M5 12h14')]);
export const IconMore = svg([circle(5.5, 12, 1.3), circle(12, 12, 1.3), circle(18.5, 12, 1.3)]);
export const IconHouse = svg([path('M4 11 12 4.5 20 11v8a1 1 0 0 1-1 1h-4v-4.5H9V20H5a1 1 0 0 1-1-1z')]);
export const IconGlobe = svg([
  circle(12, 12, 8.5),
  path('M3.5 12h17'),
  path('M12 3.5c2.5 2.4 3.8 5.4 3.8 8.5S14.5 18.1 12 20.5c-2.5-2.4-3.8-5.4-3.8-8.5S9.5 5.9 12 3.5z'),
]);
export const IconBolt = svg([path('M13 3 5 13h5l-1 8 8-10h-5z')]);
