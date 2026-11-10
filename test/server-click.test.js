import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import { CLICKABLE_SELECTOR, clickableCollectorSource } from '../server/browser.js';

/**
 * Vérifie le cœur de la détection de clic sans lancer Chromium :
 * le même code que celui injecté dans la page tourne dans un DOM simulé.
 */
function collect(html, label) {
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, {
    pretendToBeVisual: true,
    runScripts: 'outside-only',
  });
  const { window } = dom;
  // jsdom ne calcule pas de mise en page : on donne des rectangles pour les éléments visibles.
  window.Element.prototype.getBoundingClientRect = function rect() {
    if (this.hasAttribute('data-hidden')) {
      return { width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 };
    }
    const width = Number(this.getAttribute('data-w') || 200);
    const height = Number(this.getAttribute('data-h') || 40);
    return { width, height, top: 10, left: 10, right: 10 + width, bottom: 10 + height };
  };
  window.Element.prototype.checkVisibility = () => true;

  const collector = clickableCollectorSource();
  const normalizeLabel = (value) => String(value || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('fr').replace(/\s+/g, ' ').trim();

  // Le collecteur utilise `this` = window via `document`/`window` globaux du contexte V8.
  const runner = new Function('window', 'document', `return (${collector.toString()});`)(window, window.document);
  const result = runner({ selector: CLICKABLE_SELECTOR, expected: label ? normalizeLabel(label) : '' });
  dom.window.close();
  return result;
}

test('clique un bouton dont le libellé correspond exactement', () => {
  const html = `
    <a href="https://exemple.fr/a" data-w="120" data-h="30">Accueil</a>
    <button data-w="160" data-h="44">Découvrir la collection</button>`;
  const found = collect(html, 'Découvrir la collection');
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, 'bouton');
  assert.equal(found[0].label, 'Découvrir la collection');
});

test('accepte role=button et input submit comme cibles', () => {
  const roleButton = collect('<div role="button" data-w="180" data-h="50">Rejoindre</div>', 'Rejoindre');
  assert.equal(roleButton.length, 1);
  assert.equal(roleButton[0].kind, 'bouton');

  const input = collect('<input type="submit" value="Valider le formulaire" data-w="200" data-h="40">', 'Valider le formulaire');
  assert.equal(input.length, 1);
  assert.equal(input[0].kind, 'bouton');
  assert.equal(input[0].label, 'Valider le formulaire');

  const summary = collect('<details><summary data-w="200" data-h="30">Plus d’infos</summary><p>…</p></details>', 'Plus d’infos');
  assert.equal(summary.length, 1);
  assert.equal(summary[0].kind, 'résumé');
});

test('normalise casse, accents et espaces avant comparaison', () => {
  const found = collect('<button data-w="200" data-h="40">  DECOUVRIR   la   COLLECTION </button>', 'découvrir la collection');
  assert.equal(found.length, 1);
});

test('un libellé ambigu ne renvoie pas une cible unique', () => {
  const html = `
    <a href="https://exemple.fr/1" data-w="100" data-h="30">Continuer</a>
    <button data-w="100" data-h="30">Continuer</button>`;
  const found = collect(html, 'Continuer');
  assert.equal(found.length, 2, 'deux correspondances : le cycle doit être annulé');
});

test('ignore les éléments masqués ou désactivés', () => {
  const html = `
    <button data-hidden>Acheter</button>
    <button style="visibility: hidden">Acheter</button>
    <button disabled>Acheter</button>
    <button>Acheter</button>`;
  const found = collect(html, 'Acheter');
  assert.equal(found.length, 1);
});

test('sans libellé, l’élément principal privilégie le contenu au détriment de la navigation', () => {
  const html = `
    <header><a href="https://exemple.fr/" data-w="90" data-h="20">Accueil</a></header>
    <main>
      <a href="https://exemple.fr/petit" data-w="80" data-h="20">Petit lien</a>
      <button data-w="300" data-h="60">Grand appel à l’action</button>
    </main>`;
  const ranked = collect(html, '');
  assert.ok(ranked.length >= 3);
  assert.equal(ranked[0].label, 'Grand appel à l’action');
  assert.ok(ranked[0].score > ranked[ranked.length - 1].score);
});
