import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

/**
 * Les composants utilisent `globalThis.React` (voir ui/src/lib.js). On le
 * charge ici depuis public/vendor — le même fichier que sert le serveur — pour
 * tester le rendu réel, sans navigateur ni outil de compilation.
 */
const root = path.resolve(import.meta.dirname, '..');
function loadReact() {
  if (globalThis.React) return globalThis.React;
  const code = readFileSync(path.join(root, 'public/vendor/react.js'), 'utf8');
  // Le bundle est UMD : sans objet `module`, il s'attache à globalThis, comme
  // dans le navigateur. On reproduit exactement ces conditions.
  const sandbox = { console };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  const React = sandbox.React;
  assert.ok(React && typeof React.createElement === 'function', 'React doit être exposé sur globalThis');
  globalThis.React = React;
  return React;
}

/** Rend un arbre React en HTML lisible, sans DOM. */
function renderToStatic(node) {
  const React = loadReact();
  if (node === null || node === undefined || node === false) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(renderToStatic).join('');
  if (typeof node.type === 'function') return renderToStatic(node.type(node.props || {}));
  if (typeof node.type === 'string') {
    const { children, ...rest } = node.props || {};
    // On reproduit ce que React écrit réellement dans le DOM : `className`
    // devient `class`, `style` devient une chaîne CSS.
    const attributeName = (key) => (key === 'className' ? 'class' : key === 'htmlFor' ? 'for' : key);
    const attributeValue = (key, value) => {
      if (key === 'style' && value && typeof value === 'object') {
        return Object.entries(value).map(([prop, val]) => {
          const cssProp = prop.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
          return `${cssProp}:${val}`;
        }).join(';');
      }
      return String(value);
    };
    const attrs = Object.entries(rest)
      .filter(([key]) => !/^(onClick|onChange|onSubmit|key)$/.test(key))
      .map(([key, value]) => (value === true
        ? ` ${attributeName(key)}`
        : value === false || value == null
          ? ''
          : ` ${attributeName(key)}="${attributeValue(key, value)}"`))
      .join('');
    return `<${node.type}${attrs}>${renderToStatic(children)}</${node.type}>`;
  }
  return '';
}

test('React est servi en local et exporte createElement', () => {
  const React = loadReact();
  assert.equal(typeof React.createElement, 'function');
  assert.equal(typeof React.useState, 'function');
  // Le fichier servi est bien la version de production (pas de warn de dev).
  const source = readFileSync(path.join(root, 'public/vendor/react.js'), 'utf8');
  assert.match(source, /@license React/);
  assert.ok(!source.includes('react.development'), 'la version de développement ne doit pas être servie');
});

test('la carte de solde affiche 12 $ à 250 clics et 24 $ à 500 clics', async () => {
  const { BalanceCard } = await import('../ui/src/components/BalanceCard.js');
  const at250 = renderToStatic(BalanceCard({ clicks: 250, user: { email: 'nasara@exemple.com' } }));
  assert.match(at250, /\$12\.00/, 'solde à 250 clics');
  assert.match(at250, /Titulaire/);
  assert.match(at250, /nasara/);

  const at500 = renderToStatic(BalanceCard({ clicks: 500, user: null }));
  assert.match(at500, /\$24\.00/, 'solde à 500 clics');

  const at0 = renderToStatic(BalanceCard({ clicks: 0 }));
  assert.match(at0, /\$0\.00/);
  // La progression vers la tranche suivante est présente et accessible.
  assert.match(at0, /role="progressbar"/);
  assert.match(at0, /aria-valuemax="250"/);
});

test('la barre de progression suit le nombre de clics dans la tranche', async () => {
  const { BalanceCard } = await import('../ui/src/components/BalanceCard.js');
  const html = renderToStatic(BalanceCard({ clicks: 125 }));
  assert.match(html, /width:50%/, '125 clics = moitié de la tranche');
  assert.match(html, /125 \/ 250 clics/);
});

test('le barème complet est lisible dans l’onglet Clics', async () => {
  const { ClicksScreen } = await import('../ui/src/components/Screens.js');
  const html = renderToStatic(ClicksScreen({ clicksTotal: 620, todayTotal: 40, targets: [] }));
  assert.match(html, /1 – 250 clics/, 'première tranche');
  assert.match(html, /251 – 500 clics/);
  assert.match(html, /501 – 750 clics/);
  assert.match(html, /\$12\.00 par tranche \(tarif de départ\)/);
  assert.match(html, /\$8\.00 par tranche \(tarif réduit\)/);
  assert.match(html, /\$24\.00/, 'acquis à 620 clics');
});

test('les quatre actions rapides et la barre d’onglets sont présentes', async () => {
  const { QuickActions } = await import('../ui/src/components/QuickActions.js');
  const { TabBar } = await import('../ui/src/components/TabBar.js');
  const actions = renderToStatic(QuickActions({ onRun: () => {}, onRefresh: () => {}, onProxies: () => {}, onMore: () => {} }));
  for (const label of ['Lancer', 'Actualiser', 'Proxys', 'Plus']) {
    assert.ok(actions.includes(label), `action manquante : ${label}`);
  }
  const tabs = renderToStatic(TabBar({ active: 'clicks' }));
  for (const label of ['Accueil', 'Clics', 'Bot', 'Compte']) {
    assert.ok(tabs.includes(label), `onglet manquant : ${label}`);
  }
  assert.match(tabs, /class="tab active" aria-current="page"/);
});

test('le fil d’activité traduit les états en français', async () => {
  const { RecentActivity } = await import('../ui/src/components/ActivityList.js');
  const html = renderToStatic(RecentActivity({
    visits: [
      { id: '1', status: 'success', pseudo_snapshot: 'Boutique', result: { click_label: 'Acheter' }, completed_at: new Date().toISOString() },
      { id: '2', status: 'failed', pseudo_snapshot: 'Profil', result: { message: 'erreur 1020' }, completed_at: new Date().toISOString() },
    ],
  }));
  assert.ok(html.includes('réussi'));
  assert.ok(html.includes('échoué'));
  assert.match(html, /badge good/);
  assert.match(html, /badge bad/);
});
