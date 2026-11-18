import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

/**
 * Le panneau envoie du code JavaScript à exécuter DANS la page visitée
 * (`Runtime.evaluate` via chrome.debugger). Ce code ne voit que l'environnement
 * de la page : ni les fonctions du panneau, ni `InstaVAUtils` (bot-utils.js est
 * chargé dans le panneau, pas dans la page).
 *
 * Un appel à `InstaVAUtils` depuis ce code lève « InstaVAUtils is not defined »,
 * ce qui se traduit dans le journal par « Impossible de repérer les éléments
 * cliquables de la page » et fait échouer chaque cycle. Ces tests exécutent le
 * code réel dans un DOM simulé pour que ce cas ne revienne pas.
 */

const SIDE_PANEL = readFileSync(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
const BOT_UTILS = readFileSync(new URL('../extension/bot-utils.js', import.meta.url), 'utf8');

/** Source des helpers injectés dans la page (`clickableHelpersSource`). */
function helpersSource() {
  const match = SIDE_PANEL.match(/function clickableHelpersSource\(\) \{\s*return `([\s\S]*?)`;\s*\}/);
  assert.ok(match, 'clickableHelpersSource() introuvable dans sidepanel.js');
  return match[1];
}

/** Le sélecteur commun, tel que le panneau l'utilise. */
function clickableSelector() {
  const match = SIDE_PANEL.match(/const CLICKABLE_SELECTOR = '([^']+)'/);
  assert.ok(match, 'CLICKABLE_SELECTOR introuvable dans sidepanel.js');
  return match[1];
}

/**
 * Extrait le template `const expression = \`…\`` d'une fonction du panneau et
 * remplace les interpolations connues, pour obtenir exactement la chaîne que
 * `Runtime.evaluate` enverrait à la page.
 */
function expressionOf(functionName) {
  const start = SIDE_PANEL.indexOf(`async function ${functionName}(tabId`);
  assert.ok(start > 0, `fonction ${functionName} introuvable`);
  const chunk = SIDE_PANEL.slice(start, start + 6000);
  const match = chunk.match(/const expression = `([\s\S]*?)`;\n/);
  assert.ok(match, `template d'expression introuvable dans ${functionName}`);
  return match[1]
    .replace(/\$\{JSON\.stringify\(CLICKABLE_SELECTOR\)\}/g, JSON.stringify(clickableSelector()))
    .replace(/\$\{clickableHelpersSource\(\)\}/g, helpersSource());
}

/** Page de test : profil OnlyFans réel tel qu'on le rencontre sur une cible. */
const PROFILE_HTML = `<!doctype html><html lang="fr"><head><title>lana</title></head><body>
  <header><a href="https://onlyfans.com/">Accueil</a></header>
  <main>
    <h1>lana</h1>
    <p>@heyitslanaaa · Vu il y a 2 minutes</p>
    <div role="link" tabindex="0" onclick="void 0">Plus d'infos</div>
    <p>new here · i show everything · got notif on</p>
    <section><h2>ABONNEMENT</h2><button>S'ABONNER (GRATUITEMENT)</button></section>
  </main>
  <footer><a href="/privacy">Privacy</a></footer>
</body></html>`;

/**
 * Prépare un DOM exécutable. jsdom ne calcule pas de mise en page : on donne
 * des rectangles plausibles pour que `isVisible` accepte les éléments, comme
 * cela se passe sur une vraie page.
 */
function pageWindow(html, { withUtils = false } = {}) {
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://onlyfans.com/heyitslanaaa' });
  const { window } = dom;
  window.innerWidth = 1366;
  window.innerHeight = 768;
  window.Element.prototype.getBoundingClientRect = function getBoundingClientRect() {
    return { x: 10, y: 10, width: 220, height: 44, top: 10, left: 10, right: 230, bottom: 54, toJSON() {} };
  };
  // jsdom n'implémente pas `innerText` : sans ce repli, tout libellé vaut ""
  // et les tests ne mesureraient rien. Un vrai navigateur renvoie le texte rendu.
  if (!('innerText' in window.HTMLElement.prototype)) {
    Object.defineProperty(window.HTMLElement.prototype, 'innerText', {
      get() { return this.textContent; },
      configurable: true,
    });
  }
  if (withUtils) {
    // bot-utils est un script classique : on l'évalue dans la fenêtre pour
    // disposer du vrai `scoreClickable`, comme le panneau.
    window.eval(`${BOT_UTILS.replace(/^#!.*$/m, '')}`);
  }
  return window;
}

test('le code envoyé à la page ne référence jamais InstaVAUtils (absent de la page)', () => {
  // Toute occurrence dans un template `Runtime.evaluate` est un bug : le
  // panneau reçoit alors « InstaVAUtils is not defined » et le cycle échoue.
  const chunks = [];
  for (const name of ['findExactClickables', 'findPrimaryLink', 'readPageGate']) {
    const start = SIDE_PANEL.indexOf(`async function ${name}(`);
    assert.ok(start > 0, `${name} introuvable`);
    chunks.push([name, SIDE_PANEL.slice(start, start + 6000)]);
  }
  for (const [name, chunk] of chunks) {
    // On ne garde que ce qui part vers la page : les templates d'expression.
    const templates = [...chunk.matchAll(/`([\s\S]*?)`/g)].map((match) => match[1]);
    const pageSide = templates.filter((text) => text.includes('document.querySelectorAll'));
    assert.ok(pageSide.length, `${name} : aucune expression de page trouvée`);
    for (const text of pageSide) {
      // Les commentaires sont retirés : ils peuvent nommer InstaVAUtils pour
      // expliquer justement qu'il ne faut pas l'appeler ici.
      const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      assert.ok(!/InstaVAUtils/.test(code), `${name} : le code exécuté dans la page appelle InstaVAUtils`);
    }
  }
});

test('findPrimaryLink s’exécute dans la page sans lever d’exception', () => {
  const window = pageWindow(PROFILE_HTML);
  const expression = expressionOf('findPrimaryLink');
  // Avant correctif, cet appel levait ReferenceError: InstaVAUtils is not defined,
  // ce que le panneau traduisait par « Impossible de repérer les éléments cliquables ».
  const result = window.eval(expression);
  assert.ok(Array.isArray(result), 'la page doit renvoyer un tableau de candidats');
  assert.ok(result.length > 0, 'les éléments cliquables visibles doivent être renvoyés');
  const labels = result.map((item) => item.text);
  assert.ok(labels.includes("Plus d'infos"), `candidats renvoyés : ${JSON.stringify(labels)}`);
  // Le tri appartient au panneau : la page renvoie tout, sans classement.
  assert.equal(result.some((item) => 'score' in item), false, 'aucun score ne doit être calculé dans la page');
});

test('findExactClickables s’exécute dans la page et filtre sur le libellé exact', () => {
  const window = pageWindow(PROFILE_HTML);
  const start = SIDE_PANEL.indexOf('async function findExactClickables(tabId');
  const chunk = SIDE_PANEL.slice(start, start + 1600);
  const template = chunk.match(/const expression = `([\s\S]*?)`;\n/)[1];
  const expression = template
    .replace(/\$\{JSON\.stringify\(normalizedLabel\)\}/g, JSON.stringify('plus d infos'.replace(/\s+/g, ' ')))
    .replace(/\$\{clickableHelpersSource\(\)\}/g, helpersSource())
    .replace(/\$\{JSON\.stringify\(CLICKABLE_SELECTOR\)\}/g, JSON.stringify(clickableSelector()));
  const result = window.eval(expression);
  assert.ok(Array.isArray(result));
  // Aucun élément ne porte exactement « plus d infos » : la page ne doit pas lever.
  assert.equal(result.length, 0);
});

test('le classement déplacé côté panneau donne le même résultat que dans la page', () => {
  // Le classement a été déplacé hors de la page (InstaVAUtils n'y existe pas).
  // On rejoue le calcul avec la vraie fonction de bot-utils pour vérifier que
  // la sélection reste celle que le barème définit.
  const window = pageWindow(PROFILE_HTML, { withUtils: true });
  const utils = window.InstaVAUtils;
  assert.ok(utils && typeof utils.scoreClickable === 'function', 'bot-utils doit exposer scoreClickable');

  const links = window.eval(expressionOf('findPrimaryLink'));
  const scored = links.map((link) => {
    const ranking = utils.scoreClickable({
      text: link.text,
      href: link.href,
      area: link.area,
      kind: link.type,
      inNavigation: link.inNavigation,
      isControl: link.isControl,
      tagName: link.tagName,
      hasClickHandler: link.hasClickHandler,
    });
    return { ...link, score: ranking.score };
  }).sort((a, b) => b.score - a.score);

  // Les liens de la navigation ne peuvent pas être choisis tant qu'un candidat
  // hors navigation existe : c'est la règle appliquée par findPrimaryLink.
  const main = scored.filter((link) => !link.inNavigation);
  const picked = (main.length ? main : scored)[0];
  assert.ok(picked && picked.text, `élément choisi : « ${picked?.text} »`);
  assert.equal(picked.inNavigation, false, 'le candidat choisi doit être hors navigation');

  // Mesuré sur ce barème : « S'ABONNER (GRATUITEMENT) » n'est pas reconnu comme
  // libellé d'action (la liste contient « s'abonner » seul), il garde donc sa
  // prime de bouton. Un libellé d'action explicite, lui, est toujours rétrogradé.
  const action = utils.scoreClickable({ text: 'Suivre', href: '', area: 9680, kind: 'bouton', isControl: true });
  const neutral = utils.scoreClickable({ text: "Plus d'infos", href: '', area: 9680, kind: 'lien', hasClickHandler: true });
  assert.equal(action.actionButton, true);
  assert.ok(neutral.score > action.score, `neutre ${neutral.score} doit dépasser action ${action.score}`);

  // Un lien de bio court reste prioritaire sur tout bouton, action ou non.
  const bio = utils.scoreClickable({ text: 'shop', href: 'https://instagram.com/shop.brand', area: 5400, kind: 'lien' });
  assert.ok(bio.score > neutral.score, `bio ${bio.score} doit dépasser le lien neutre ${neutral.score}`);
});

test('un échec de détection n’est jamais imputé au proxy', () => {
  // Trouvé en lisant un journal réel : chaque cycle échouait sur
  // « Impossible de repérer les éléments cliquables de la page » et le proxy
  // passait pour fautif (« échec 1/3 »), jusqu'à désactivation automatique.
  // Un bug de lecture de page ne dit rien de la qualité de l'IP.
  const source = readFileSync(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
  const match = source.match(/function errorLooksLikeDetectionFailure\(error\) \{\s*return (\/[\s\S]*?\/[a-z]*)\s*\n\s*\.test/);
  assert.ok(match, 'errorLooksLikeDetectionFailure introuvable');
  const pattern = eval(match[1]); // littéral RegExp du fichier

  const detection = [
    "Impossible de repérer les éléments cliquables de la page.",
    "Impossible de vérifier le libellé du lien ou du bouton dans la page.",
    "Aucun lien ou bouton visible ne correspond à « Plus d'infos ».",
    "Plusieurs éléments correspondent à « Voir » (lien « Voir », bouton « Voir »).",
    'La page a changé pendant la vérification; aucun clic effectué.',
  ];
  for (const message of detection) {
    assert.ok(pattern.test(message), `doit être reconnu comme détection : ${message}`);
  }

  const network = [
    'net::ERR_TUNNEL_CONNECTION_FAILED',
    'net::ERR_PROXY_CONNECTION_FAILED',
    'Délai dépassé pendant la stabilisation de la page.',
    'Aucune redirection détectée après le clic.',
  ];
  for (const message of network) {
    assert.equal(pattern.test(message), false, `ne doit pas être classé détection : ${message}`);
  }
});
