import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// traffic.js est un SCRIPT CLASSIQUE (comme bot-utils.js) : il n'a pas
// d'export ES. On l'évalue et on lit son API sur le global, exactement comme
// le fait le panneau dans le navigateur.
const {
  DEFAULT_BLOCKED_TYPES,
  DEFAULT_BLOCKED_URL_PATTERNS,
  OPTIONAL_TYPES,
  PROTECTED_TYPES,
  KNOWN_TYPES,
  normalizeBlockedTypes,
  buildBlockPolicy,
  summarizeSavings,
  formatBytes,
  parseMegabyteLimit,
  evaluateTrafficBudget,
} = (() => {
  const source = readFileSync(new URL('../extension/traffic.js', import.meta.url), 'utf8');
  const holder = {};
  new Function('globalThis', 'module', source)(holder, { exports: {} });
  return holder.InstaVATraffic;
})();

const SIDE_PANEL = readFileSync(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
const MANIFEST = JSON.parse(readFileSync(new URL('../extension/manifest.json', import.meta.url), 'utf8'));

test('les types bloqués par défaut couvrent le gros du poids, sans casser le rendu', () => {
  // Images, vidéos et polices : l'essentiel des mégaoctets, jamais cliquables.
  for (const type of ['Image', 'Media', 'Font']) {
    assert.ok(DEFAULT_BLOCKED_TYPES.includes(type), `${type} doit être bloqué par défaut`);
  }
  // Les feuilles de style portent display/visibility/opacity : sans elles, un
  // élément masqué paraîtrait visible et le clic partirait dans le vide.
  assert.ok(!DEFAULT_BLOCKED_TYPES.includes('Stylesheet'), 'les CSS ne sont pas bloquées par défaut');
  assert.deepEqual(OPTIONAL_TYPES, ['Stylesheet'], 'elles restent proposables, jamais imposées');
  // Chaque type par défaut doit avoir une correspondance DNR exacte : mapper un
  // type sur le fourre-tout « other » bloquerait bien plus que demandé.
  for (const type of DEFAULT_BLOCKED_TYPES) {
    assert.ok(['Image', 'Media', 'Font'].includes(type), `${type} n’a pas de correspondance DNR exacte`);
  }
  // Sans ces types, ni détection ni clic ne sont possibles.
  for (const type of ['Document', 'Script', 'XHR', 'Fetch']) {
    assert.ok(PROTECTED_TYPES.includes(type));
    assert.ok(!DEFAULT_BLOCKED_TYPES.includes(type), `${type} ne doit jamais être bloqué`);
  }
});

test('les types bloqués sont tous des valeurs légales du protocole CDP', () => {
  // Un nom inventé ferait échouer la règle en silence : le bot croirait
  // économiser alors que rien n'est bloqué.
  for (const type of DEFAULT_BLOCKED_TYPES) {
    assert.ok(KNOWN_TYPES.includes(type), `${type} n’est pas un Network.ResourceType`);
  }
});

test('normalizeBlockedTypes corrige la casse et refuse les types protégés', () => {
  assert.deepEqual(normalizeBlockedTypes(['image', 'IMAGE', 'Media']), ['Image', 'Media']);
  // Tenter de bloquer le document ou les scripts est ignoré : la visite
  // deviendrait impossible.
  assert.deepEqual(normalizeBlockedTypes(['document', 'script', 'xhr', 'fetch', 'image']), ['Image']);
  // Une valeur inconnue est ignorée sans faire échouer le reste.
  assert.deepEqual(normalizeBlockedTypes(['Licorne', 'font']), ['Font']);
  assert.deepEqual(normalizeBlockedTypes(null), []);
  assert.deepEqual(normalizeBlockedTypes('Image'), [], 'une chaîne n’est pas une liste');
});

test('buildBlockPolicy applique les défauts et respecte une liste explicite', () => {
  const byDefault = buildBlockPolicy();
  assert.equal(byDefault.active, true);
  assert.deepEqual(byDefault.types, [...DEFAULT_BLOCKED_TYPES]);
  assert.deepEqual(byDefault.patterns, [...DEFAULT_BLOCKED_URL_PATTERNS]);

  // Liste explicite vide : c'est un choix, on ne le remplace pas par les défauts.
  const none = buildBlockPolicy({ blockedTypes: [], blockedUrlPatterns: [] });
  assert.equal(none.active, false, 'sans type ni motif, le blocage est inactif');
  assert.deepEqual(none.types, []);

  // Liste partielle : seuls ces types sont bloqués.
  const custom = buildBlockPolicy({ blockedTypes: ['image'], blockedUrlPatterns: [] });
  assert.deepEqual(custom.types, ['Image']);
  assert.deepEqual(custom.patterns, []);
  assert.equal(custom.active, true);
});

test('les motifs d’URL visent des traceurs, jamais un contenu de page', () => {
  for (const pattern of DEFAULT_BLOCKED_URL_PATTERNS) {
    assert.match(pattern, /^\*:\/\/\*\./, `${pattern} doit viser un sous-domaine précis`);
    assert.ok(!/^\*:\/\/\*\/\*$/.test(pattern), 'aucun motif global');
  }
  // Un bloqueur d'images au niveau URL casserait les data-URI et les SVG
  // intégrés ; on ne liste que de la mesure d'audience.
  assert.ok(DEFAULT_BLOCKED_URL_PATTERNS.some((pattern) => pattern.includes('google-analytics')));
  assert.ok(!DEFAULT_BLOCKED_URL_PATTERNS.some((pattern) => pattern.includes('instagram')));
});

test('summarizeSavings ne raconte que ce qui a été mesuré', () => {
  const measured = summarizeSavings({ beforeBytes: 4_000_000, afterBytes: 400_000, visits: 10 });
  assert.equal(measured.saved, 3_600_000);
  assert.equal(measured.ratio, 0.9);
  assert.equal(measured.perVisit, 40_000);

  // Aucune mesure : aucune économie inventée.
  const unknown = summarizeSavings({});
  assert.deepEqual(unknown, { before: 0, after: 0, saved: 0, ratio: 0, perVisit: 0 });

  // Des octets négatifs ou absurdes ne produisent pas de statistique folle.
  const weird = summarizeSavings({ beforeBytes: -5, afterBytes: 'x', visits: -2 });
  assert.equal(weird.saved, 0);
  assert.equal(weird.perVisit, 0);
});

test('formatBytes reste lisible dans les ordres de grandeur réels', () => {
  assert.equal(formatBytes(0), '0 o');
  assert.equal(formatBytes(512), '512 o');
  assert.equal(formatBytes(4_000), '4,00 Ko');
  assert.equal(formatBytes(250_000), '250 Ko');
  assert.equal(formatBytes(3_000_000), '3,00 Mo');
  assert.equal(formatBytes(36_000_000_000), '36,0 Go');
});

test('le panneau active le blocage avant le premier octet de la visite', () => {
  // Ordre critique : le blocage doit être en place avant `tabs.update`, sinon
  // la page est déjà téléchargée quand les règles arrivent.
  const blockAt = SIDE_PANEL.indexOf('await enableTrafficSaving([');
  const navigateAt = SIDE_PANEL.indexOf('await chromeCall(chrome.tabs.update, tab.id, { url });');
  assert.ok(blockAt > 0, 'enableTrafficSaving doit être appelé');
  assert.ok(navigateAt > 0, 'la navigation doit exister');
  assert.ok(blockAt < navigateAt, 'le blocage doit précéder la navigation');

  // Et il doit être libéré dans le finally, sinon les règles fuient d'un
  // cycle à l'autre et finissent par bloquer hors visite.
  assert.ok(/traffic\.dispose\(\)/.test(SIDE_PANEL), 'les règles doivent être retirées');
  assert.ok(/recordTrafficStats\(/.test(SIDE_PANEL), 'les octets mesurés doivent être enregistrés');
});

test('les règles DNR utilisent des types déclaratif valides', () => {
  const map = SIDE_PANEL.match(/const DNR_TYPE_BY_CDP = \{([\s\S]*?)\};/);
  assert.ok(map, 'DNR_TYPE_BY_CDP introuvable');
  const allowed = new Set([
    'main_frame', 'sub_frame', 'stylesheet', 'script', 'image', 'font', 'object',
    'xmlhttprequest', 'ping', 'csp_report', 'media', 'websocket', 'other',
  ]);
  for (const [, value] of map[1].matchAll(/:\s*"([a-z_]+)"/g)) {
    assert.ok(allowed.has(value), `${value} n’est pas un ResourceType declarativeNetRequest`);
  }
  // Chaque type bloqué par défaut doit avoir sa correspondance, sinon il est
  // silencieusement ignoré.
  for (const type of DEFAULT_BLOCKED_TYPES) {
    assert.ok(new RegExp(`\\b${type}:\\s*"`).test(map[1]), `${type} n’a pas de correspondance DNR`);
  }
});

test('le manifeste autorise declarativeNetRequest', () => {
  assert.ok(MANIFEST.permissions.includes('declarativeNetRequest'),
    'sans cette permission, aucun blocage réseau n’est possible');
  // La permission webRequest reste nécessaire pour mesurer les octets.
  assert.ok(MANIFEST.permissions.includes('webRequest'));
});

test('les règles sont des règles de session, seules autorisées à viser des onglets', () => {
  // Chrome rejette une règle dynamique portant `tabIds` : la règle entière
  // serait perdue et le bot croirait filtrer sans rien filtrer.
  assert.ok(/getSessionRules/.test(SIDE_PANEL), 'les règles doivent être lues en session');
  assert.ok(/updateSessionRules/.test(SIDE_PANEL), 'les règles doivent être écrites en session');
  assert.ok(!/updateDynamicRules/.test(SIDE_PANEL), 'aucune règle dynamique ne doit porter tabIds');
});

test('le blocage ne vise que les onglets du bot', () => {
  // Sans portée, la navigation personnelle de l'utilisateur serait filtrée
  // pendant toute la visite.
  assert.ok(/const botTabIds =/.test(SIDE_PANEL), 'une portée explicite doit exister');
  assert.ok(/tabIds: \[\.\.\.scope\]/.test(SIDE_PANEL), 'les règles doivent porter tabIds');
  // L'onglet d'origine est passé à l'activation...
  assert.match(SIDE_PANEL, /enableTrafficSaving\(\[tab\.id\]\)/);
  // ...et les onglets ouverts par un clic rejoignent la portée, sinon ils
  // chargeraient la page de destination sans filtre.
  assert.match(SIDE_PANEL, /traffic\?\.includeTab\?\.\(childTab\.id\)/);
});

test('la mesure du trafic ne dépend pas d’options coûteuses', () => {
  // `["responseHeaders"]` force Chrome à collecter tous les en-têtes de toutes
  // les réponses ; le gain de mesure serait nul et le coût réel.
  assert.ok(!/["']responseHeaders["']/.test(SIDE_PANEL), 'pas de collecte d’en-têtes');
  assert.ok(/encodedDataLength/.test(SIDE_PANEL), 'les octets mesurés viennent du réseau');
});

test('une limite en Mo vide ou nulle signifie « illimité »', () => {
  for (const value of [null, undefined, '', '   ', 0, '0', -5]) {
    const parsed = parseMegabyteLimit(value);
    assert.equal(parsed.ok, true, `${JSON.stringify(value)} doit être accepté comme « illimité »`);
    assert.equal(parsed.bytes, null);
  }
  // Une limite valide est convertie en octets (base 1000, comme le fournisseur).
  assert.equal(parseMegabyteLimit('15').bytes, 15_000_000);
  assert.equal(parseMegabyteLimit('1,5').bytes, 1_500_000, 'la virgule décimale est acceptée');
});

test('une limite en Mo absurde est refusée avec un message', () => {
  assert.equal(parseMegabyteLimit('beaucoup').ok, false);
  assert.equal(parseMegabyteLimit('1e12').ok, false);
  assert.match(parseMegabyteLimit('beaucoup').message, /invalide/i);
});

test('le plafond laisse passer tant qu’il reste de la place', () => {
  const decision = evaluateTrafficBudget({ limitBytes: 10_000_000, usedBytes: 2_000_000, reserveBytes: 1_000_000 });
  assert.equal(decision.allowed, true);
  assert.equal(decision.reason, 'within-limit');
  assert.equal(decision.remainingBytes, 8_000_000);
});

test('le plafond arrête la série quand la réserve ne tient plus', () => {
  // 9,5 Mo consommés sur 10 : il reste 0,5 Mo, moins qu'une visite (~1 Mo).
  const decision = evaluateTrafficBudget({ limitBytes: 10_000_000, usedBytes: 9_500_000, reserveBytes: 1_000_000 });
  assert.equal(decision.allowed, false, 'la visite suivante dépasserait le plafond');
  assert.equal(decision.reason, 'reserve-exceeded');
});

test('plafond atteint : plus aucune visite', () => {
  const decision = evaluateTrafficBudget({ limitBytes: 10_000_000, usedBytes: 10_000_000, reserveBytes: 1_000_000 });
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, 'limit-reached');
  assert.equal(decision.remainingBytes, 0);
  // Même au-delà (mesure imprécise), on reste bloqué.
  assert.equal(evaluateTrafficBudget({ limitBytes: 10_000_000, usedBytes: 12_000_000 }).allowed, false);
});

test('un plafond plus petit qu’une visite laisse passer la première', () => {
  // Sinon le bot ne ferait jamais rien avec un plafond de 0,5 Mo.
  const first = evaluateTrafficBudget({ limitBytes: 500_000, usedBytes: 0, reserveBytes: 1_000_000 });
  assert.equal(first.allowed, true);
  assert.equal(first.reason, 'limit-below-one-visit');
  // Une fois cette visite faite, on s'arrête.
  const after = evaluateTrafficBudget({ limitBytes: 500_000, usedBytes: 400_000, reserveBytes: 1_000_000 });
  assert.equal(after.allowed, false);
});

test('sans plafond, le bot n’est jamais arrêté', () => {
  for (const used of [0, 5_000_000, 900_000_000]) {
    const decision = evaluateTrafficBudget({ limitBytes: null, usedBytes: used, reserveBytes: 1_000_000 });
    assert.equal(decision.allowed, true);
    assert.equal(decision.reason, 'no-limit');
    assert.equal(decision.remainingBytes, null);
  }
});

test('le contrôle du plafond est bien branché avant chaque visite', () => {
  // Sans cet appel dans la boucle, le plafond serait un simple affichage.
  assert.ok(/const budget = await checkTrafficBudget\(\)/.test(SIDE_PANEL), 'checkTrafficBudget doit être appelé dans la boucle');
  const checkAt = SIDE_PANEL.indexOf('const budget = await checkTrafficBudget()');
  const runAt = SIDE_PANEL.indexOf('await executeTargetRun(');
  assert.ok(checkAt > 0 && runAt > 0 && checkAt < runAt, 'le contrôle doit précéder le lancement de la visite');
  // Atteint, il doit arrêter la série et le dire.
  assert.match(SIDE_PANEL, /Plafond de consommation atteint/);
  assert.match(SIDE_PANEL, /stopRequested = true/);
});
