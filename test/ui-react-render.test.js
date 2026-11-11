import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';

/**
 * Rendu complet de l'application dans un DOM réel, avec le React et le
 * ReactDOM servis par le serveur. C'est la vérification la plus proche d'un
 * navigateur qu'il est possible de faire sans navigateur.
 */
const root = path.resolve(import.meta.dirname, '..');

/**
 * Exécute un bundle UMD dans son propre contexte, avec le vrai `window` jsdom.
 *
 * ReactDOM teste `x instanceof window.HTMLIFrameElement` : lui donner un objet
 * factice à la place de `window` fait échouer ce test. On lui passe donc
 * l'objet window de jsdom, exactement comme dans un navigateur.
 */
function loadBundle(file, globalName, window, prelude = {}) {
  const code = readFileSync(path.join(root, 'public/vendor', file), 'utf8');
  const sandbox = {
    console, setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
    window, document: window.document, self: window, ...prelude,
  };
  sandbox.globalThis = window;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return window[globalName];
}

function setupDom() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://127.0.0.1/',
    pretendToBeVisual: true,
    runScripts: 'outside-only',
  });
  const { window } = dom;
  const previous = {};
  // On installe les globales qu'un navigateur fournit déjà, comme le fait le
  // harnais existant du dépôt : mêmes noms, mêmes objets jsdom.
  const names = ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event',
    'requestAnimationFrame', 'cancelAnimationFrame'];
  for (const name of names) {
    previous[name] = Object.getOwnPropertyDescriptor(globalThis, name);
    try {
      Object.defineProperty(globalThis, name, {
        value: name === 'window' ? window : window[name] ?? globalThis[name],
        configurable: true,
        writable: true,
      });
    } catch { /* propriété non configurable : on laisse Node la gérer */ }
  }
  globalThis.IS_REACT_ACT_ENVIRONMENT = false;
  return { dom, restore: () => {
    for (const [name, descriptor] of Object.entries(previous)) {
      try {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else delete globalThis[name];
      } catch { /* rien à restaurer */ }
    }
  } };
}

test('l’application complète se monte et affiche le solde calculé', async () => {
  const { dom, restore } = setupDom();
  const React = loadBundle('react.js', 'React', window);
  // ReactDOM attend `window.React` : il le trouve puisque React vient d'être
  // posé sur le même window, comme dans le navigateur.
  const ReactDOM = loadBundle('react-dom.js', 'ReactDOM', window);
  globalThis.React = React;
  globalThis.ReactDOM = ReactDOM;

  // API simulée : 500 clics au total, une cible, un moteur en marche.
  const api = {
    health: async () => ({ ok: true, version: '2.0.0', timeZone: 'Africa/Porto-Novo', worker: { running: true, active: 1, restarts: 2 } }),
    me: async () => ({ user: { email: 'nasara@exemple.com', role: 'owner' } }),
    visits: async () => ({
      visits: [{ id: 'v1', status: 'success', pseudo_snapshot: 'Boutique', result: { click_label: 'Acheter' }, completed_at: new Date().toISOString() }],
      clicksByTarget: [{ target_id: 't1', pseudo: 'Boutique', today: 40, clicksTotal: 500 }],
      clicksTotal: 500,
      todayTotal: 40,
    }),
    targets: async () => ({ targets: [{ id: 't1', pseudo: 'Boutique', url: 'https://exemple.fr', mode: 'goal' }] }),
    start: async () => ({ targets: [{ pseudo: 'Boutique', visits: 4 }] }),
    login: async () => ({ user: { email: 'nasara@exemple.com' } }),
    register: async () => ({ user: { email: 'nasara@exemple.com' } }),
    logout: async () => ({}),
  };

  try {
    const { App } = await import('../ui/src/App.js');
    const container = window.document.getElementById('root');
    const rootReact = ReactDOM.createRoot(container);
    rootReact.render(React.createElement(App, { api }));

    // Laisse les effets (health, me, visits) s'exécuter.
    await new Promise((resolve) => setTimeout(resolve, 120));

    const text = container.textContent;
    assert.match(text, /Bonjour nasara/, 'salutation personnalisée');
    assert.match(text, /\$24\.00/, 'le solde affiché correspond à 500 clics');
    assert.match(text, /Boutique/, 'la cible apparaît');
    assert.match(text, /40 clic\(s\) aujourd’hui/, 'les clics du jour sont affichés');
    // Les quatre actions et la navigation basse sont rendues.
    for (const label of ['Lancer', 'Actualiser', 'Proxys', 'Plus']) {
      assert.ok(text.includes(label), `action manquante : ${label}`);
    }
    for (const label of ['Accueil', 'Clics', 'Bot', 'Compte']) {
      assert.ok(text.includes(label), `onglet manquant : ${label}`);
    }
    // Aucun message d'erreur de chargement.
    assert.ok(!text.includes('Chargement…'), 'l’application doit être montée');
    rootReact.unmount();
  } finally {
    restore();
  }
});

test('sans session, l’application montre l’écran de connexion', async () => {
  const { dom, restore } = setupDom();
  const React = loadBundle('react.js', 'React', window);
  // ReactDOM attend `window.React` : il le trouve puisque React vient d'être
  // posé sur le même window, comme dans le navigateur.
  const ReactDOM = loadBundle('react-dom.js', 'ReactDOM', window);
  globalThis.React = React;
  globalThis.ReactDOM = ReactDOM;
  const api = {
    health: async () => ({ ok: true, firstRun: true, setupOpen: true }),
    me: async () => { throw new Error('non connecté'); },
  };
  try {
    const { App } = await import('../ui/src/App.js');
    const container = window.document.getElementById('root');
    const rootReact = ReactDOM.createRoot(container);
    rootReact.render(React.createElement(App, { api }));
    await new Promise((resolve) => setTimeout(resolve, 100));
    const text = container.textContent;
    assert.match(text, /Bienvenue/, 'première installation');
    assert.match(text, /Créer le compte/);
    assert.ok(!text.includes('$'), 'aucun solde inventé avant connexion');
    rootReact.unmount();
  } finally {
    restore();
  }
});
