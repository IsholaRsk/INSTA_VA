import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

// Les scripts type="module" ne s'exécutent pas sous jsdom : on vérifie le câblage statique
// (identifiants présents, aucune référence à l'ancienne API mono-proxy, appels cohérents).
test('interface : la section proxys expose l’import en masse et la rotation', async () => {
  const html = await readFile(new URL('../public/legacy.html', import.meta.url), 'utf8');
  const dom = new JSDOM(html);
  const { document } = dom.window;

  for (const id of ['proxy-text', 'proxy-scheme', 'proxy-username', 'proxy-password', 'proxy-rotation', 'save-proxy', 'test-proxies', 'remove-proxy', 'proxy-enabled', 'proxy-list', 'proxy-summary', 'proxy-badge']) {
    assert.ok(document.getElementById(id), `#${id} doit exister`);
  }
  const textarea = document.getElementById('proxy-text');
  assert.equal(textarea.tagName, 'TEXTAREA');
  assert.match(textarea.getAttribute('placeholder'), /hôte:port:identifiant:motdepasse/);

  // Plus aucun champ mono-proxy.
  for (const removed of ['proxy-host', 'proxy-port', 'proxy-form-scheme']) {
    assert.equal(document.getElementById(removed), null, `#${removed} doit avoir disparu`);
  }
  // La mention honnête sur les proxys datacenter est présente.
  assert.match(document.querySelector('.proxy-copy').textContent, /datacenter/);
});

test('interface : le client parle uniquement à /api/proxies', async () => {
  const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.ok(source.includes("'/api/proxies'"), 'liste et import');
  assert.ok(source.includes('/api/proxies/test'), 'route de test');
  assert.ok(source.includes("id=disabled"), 'purge des désactivés');
  assert.ok(!/['"`]\/api\/proxy['"`]/.test(source), 'l’ancienne route /api/proxy ne doit plus être appelée');
  assert.ok(!source.includes('proxyConfigured'), 'état mono-proxy supprimé');
});

test('proxys : les erreurs réseau sont traduites, jamais renvoyées en anglais', async () => {
  const { friendlyProxyError } = await import('../server/proxies.js');
  assert.equal(friendlyProxyError(new Error('read ECONNRESET')), 'Le proxy a coupé la connexion.');
  assert.equal(friendlyProxyError(new Error('connect ECONNREFUSED 1.2.3.4:80')), 'Connexion au proxy impossible (refusée).');
  assert.equal(friendlyProxyError(new Error('getaddrinfo ENOTFOUND proxy')), 'Hôte du proxy introuvable.');
  assert.equal(friendlyProxyError(new Error('socket hang up')), 'Le proxy a coupé la connexion.');
  assert.match(friendlyProxyError(new Error('')), /n’a pas répondu/);
});

test('import fichier : le sélecteur, le glisser-déposer et la remise à zéro sont câblés', async () => {
  const html = await readFile(new URL('../public/legacy.html', import.meta.url), 'utf8');
  const { document } = new JSDOM(html).window;
  for (const id of ['proxy-file', 'proxy-file-button', 'proxy-file-clear', 'proxy-file-name', 'proxy-drop']) {
    assert.ok(document.getElementById(id), `#${id} doit exister`);
  }
  const input = document.getElementById('proxy-file');
  assert.equal(input.getAttribute('type'), 'file');
  assert.match(input.getAttribute('accept'), /\.txt/);

  const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.ok(source.includes("dropZone.addEventListener('drop'"), 'glisser-déposer');
  assert.ok(source.includes('fileInput.click()'), 'bouton « Choisir un fichier »');
  assert.ok(source.includes('TextDecoder'), 'décodage hors UTF-8');
  assert.ok(source.includes("\\r\\n?/g, '\\n'"), 'normalisation des fins de ligne Windows');
  assert.ok(source.includes('MAX_PROXY_FILE_BYTES'), 'garde-fou de taille côté navigateur');
});

test('import fichier : le service worker n’immobilise pas une ancienne interface', async () => {
  const sw = await readFile(new URL('../public/sw.js', import.meta.url), 'utf8');
  assert.ok(!sw.includes("'instava-bot-v2'"), 'le cache doit avoir changé de version');
  assert.ok(sw.includes("startsWith(CACHE_PREFIX)"), 'les anciens caches doivent être purgés');
  // Réseau d'abord pour les fichiers statiques : une mise à jour se voit tout de suite.
  const staticBranch = sw.slice(sw.indexOf("  event.respondWith((async () => {\n    try {"));
  assert.ok(staticBranch.indexOf('await fetch(request)') < staticBranch.indexOf('caches.match(request)'), 'réseau avant cache');
});

test('import fichier : un fichier UTF-16 avec BOM et CRLF est décodé sans caractère parasite', async () => {
  // Reproduit un export Windows : BOM, UTF-16LE, fins de ligne \r\n.
  const lines = ['proxy1.exemple.fr:8000:identifiantfictif:motdepassefictif', 'proxy2.exemple.fr:8001:identifiantfictif:motdepassefictif'];
  const bytes = Buffer.from('\uFEFF' + lines.join('\r\n') + '\r\n', 'utf16le');

  const { JSDOM } = await import('jsdom');
  const { readFile } = await import('node:fs/promises');
  const dom = new JSDOM(await readFile(new URL('../public/legacy.html', import.meta.url), 'utf8'), { url: 'http://127.0.0.1/' });
  const previous = { window: globalThis.window, document: globalThis.document, TL: globalThis.TextDecoder };
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  try {
    const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
    const api = await new Function(`return (async () => { ${source}
      return { decodeProxyFile };
    })()`)();
    const file = { arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
    const decoded = await api.decodeProxyFile(file);
    // TextDecoder('utf-16le') retire le BOM de lui-même : le texte commence
    // directement par le premier proxy, sans caractère invisible.
    assert.notEqual(decoded.charCodeAt(0), 0xfeff, 'aucun BOM résiduel en tête');
    assert.ok(decoded.startsWith('proxy1.exemple.fr:8000:'), `texte inattendu : ${JSON.stringify(decoded.slice(0, 40))}`);
    assert.equal(decoded.includes('\u0000'), false, 'aucun octet nul (signe d’un mauvais décodage)');
    // C'est readProxyFile qui normalise les fins de ligne ; on rejoue les deux étapes.
    const normalized = decoded.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim();
    assert.deepEqual(normalized.split('\n'), lines);
    assert.equal(normalized.includes('\u0000'), false, 'aucun octet nul (signe d’un mauvais décodage)');
    // Laisse les micro-tâches de rendu se terminer avant de rendre la main.
    await new Promise((resolve) => setTimeout(resolve, 50));
  } finally {
    globalThis.window = previous.window;
    globalThis.document = previous.document;
  }
});

test('activité : l’IP de sortie est visible dans l’application, pas seulement dans les logs', async () => {
  const { readFile } = await import('node:fs/promises');
  const { JSDOM } = await import('jsdom');
  const html = await readFile(new URL('../public/legacy.html', import.meta.url), 'utf8');
  const dom = new JSDOM(html, { url: 'http://127.0.0.1/' });
  const previous = { window: globalThis.window, document: globalThis.document };
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  try {
    const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
    const api = await new Function(`return (async () => { ${source}
      return { renderActivity };
    })()`)();

    // Cycle passé par un proxy.
    api.renderActivity([{
      id: 'v1', status: 'success', pseudo: 'Cible', visit_number: 1,
      completed_at: new Date().toISOString(),
      result: { click_kind: 'bouton', click_label: 'Voir', final_url: 'https://exemple.fr/x',
        exit_ip: '51.15.10.20', proxy_host: '141.94.255.57' },
    }]);
    const viaProxy = dom.window.document.querySelector('.activity-exit');
    assert.ok(viaProxy, 'la ligne d’IP de sortie doit être affichée');
    assert.match(viaProxy.textContent, /141\.94\.255\.57/);
    assert.match(viaProxy.textContent, /51\.15\.10\.20/);

    // Cycle sorti directement : c'est le signal d'alerte.
    api.renderActivity([{
      id: 'v2', status: 'success', pseudo: 'Cible', visit_number: 2,
      completed_at: new Date().toISOString(),
      result: { click_kind: 'bouton', final_url: 'https://exemple.fr/y', exit_ip: '203.0.113.7', proxy_host: null },
    }]);
    const direct = dom.window.document.querySelector('.activity-exit');
    assert.match(direct.textContent, /directe|VPS/);
    // Laisse les micro-tâches de rendu se terminer avant de rendre la main.
    await new Promise((resolve) => setTimeout(resolve, 50));
  } finally {
    globalThis.window = previous.window;
    globalThis.document = previous.document;
  }
});

test('test des proxys : la nature de l’IP de sortie est affichée, datacenter signalé', async () => {
  const { readFile } = await import('node:fs/promises');
  const { JSDOM } = await import('jsdom');
  const html = await readFile(new URL('../public/legacy.html', import.meta.url), 'utf8');
  const dom = new JSDOM(html, { url: 'http://127.0.0.1/' });
  const previous = { window: globalThis.window, document: globalThis.document };
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  try {
    const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
    const api = await new Function(`return (async () => { ${source}
      return { renderProxies, setRecords: (r) => { proxyRecords = r; }, setState: (s) => { proxyState = s; },
        setResults: (m) => { proxyTestResults = m; } };
    })()`)();

    api.setRecords([
      { id: 'p1', host: 'proxy1.exemple.fr', port: 8080, scheme: 'http', username: 'id••', enabled: true,
        cycles: 0, successes: 0, failures: 0, consecutive_failures: 0, last_error: null, last_used_at: null },
    ]);
    api.setState({ enabled: true, rotation: 'order', cursor: 0, disableAfter: 3 });
    api.setResults(new Map([['p1', { id: 'p1', ok: true, exitIp: '51.15.10.20', ipKind: 'datacenter', asn: 16276, provider: 'OVH' }]]));
    api.renderProxies();

    const tags = [...dom.window.document.querySelectorAll('.proxy-tag')].map((tag) => tag.textContent);
    assert.ok(tags.some((text) => /Datacenter/.test(text)), `nature affichée : ${tags.join(' | ')}`);
    assert.ok(tags.some((text) => /OVH/.test(text)), 'fournisseur affiché');
    assert.ok(tags.some((text) => /AS16276/.test(text)), 'ASN affiché');
    assert.ok(tags.some((text) => /51\.15\.10\.20/.test(text)), 'IP de sortie affichée');

    // Une IP résidentielle ne doit pas être signalée comme un problème.
    api.setResults(new Map([['p1', { id: 'p1', ok: true, exitIp: '88.120.1.1', ipKind: 'residential', org: 'Free SAS' }]]));
    api.renderProxies();
    const after = [...dom.window.document.querySelectorAll('.proxy-tag')].map((tag) => tag.textContent);
    assert.ok(after.some((text) => /Résidentiel/.test(text)), 'résidentiel reconnu');
    assert.ok(!after.some((text) => /Datacenter/.test(text)), 'plus de mention datacenter');
    await new Promise((resolve) => setTimeout(resolve, 50));
  } finally {
    globalThis.window = previous.window;
    globalThis.document = previous.document;
  }
});

test('diagnostic : le panneau affiche les cinq contrôles et l’état réel', async () => {
  const { readFile } = await import('node:fs/promises');
  const { JSDOM } = await import('jsdom');
  const html = await readFile(new URL('../public/legacy.html', import.meta.url), 'utf8');
  const dom = new JSDOM(html, { url: 'http://127.0.0.1/' });
  const previous = { window: globalThis.window, document: globalThis.document };
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  try {
    for (const id of ['diagnostic-list', 'diagnostic-badge', 'clear-sessions', 'diagnostic-message']) {
      assert.ok(dom.window.document.getElementById(id), `#${id} doit exister`);
    }
    const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
    // Serveur simulé : un proxy datacenter, empreinte correcte, aucune session.
    globalThis.fetch = async (input) => {
      if (String(input).includes('/api/diagnostic')) {
        return new Response(JSON.stringify({
          fingerprint: { ok: true, uaVersion: '158', note: 'JA3 produit par Chromium.' },
          proxies: { total: 1, enabled: 1, datacenter: 1, residential: 0, unknown: 0, priority: false },
          sessions: 0,
          rules: { ip: 'Aucun proxy résidentiel identifié.', cookies: 'Aucune session.' },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const api = await new Function(`return (async () => { ${source}
      return { loadDiagnostic };
    })()`)();
    await api.loadDiagnostic();
    const rows = [...dom.window.document.querySelectorAll('.diagnostic-row')];
    assert.equal(rows.length, 4, 'IP, réputation, TLS, cookies');
    const text = rows.map((row) => row.textContent).join(' ');
    assert.match(text, /IP et réseau/);
    assert.match(text, /Réputation/);
    assert.match(text, /Empreinte TLS/);
    assert.match(text, /Cookies/);
    // Un seul proxy datacenter : le premier contrôle doit être signalé.
    assert.ok(rows[0].classList.contains('is-bad'), 'le manque de résidentiel est signalé');
    assert.match(dom.window.document.getElementById('diagnostic-badge').textContent, /bloquant/);
    await new Promise((resolve) => setTimeout(resolve, 50));
  } finally {
    globalThis.window = previous.window;
    globalThis.document = previous.document;
  }
});

test('thème : le panneau d’état du bot reflète le moteur sans jargon', async () => {
  const { readFile } = await import('node:fs/promises');
  const { JSDOM } = await import('jsdom');
  const html = await readFile(new URL('../public/legacy.html', import.meta.url), 'utf8');
  const dom = new JSDOM(html, { url: 'http://127.0.0.1/' });
  const previous = { window: globalThis.window, document: globalThis.document };
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  try {
    // Le script de l'application se lance au chargement (boot()) : on lui donne
    // un fetch qui ne répond jamais, puis on rend ses erreurs muettes, sinon
    // l'activité asynchrone retarde la fin du test.
    globalThis.fetch = () => new Promise(() => {});
    const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
    const api = await new Function(`return (async () => { ${source}
      return { renderBotStatus };
    })()`)().catch(() => ({ renderBotStatus: null }));
    assert.ok(api.renderBotStatus, 'renderBotStatus doit être exposée');
    const text = dom.window.document.getElementById('bot-status-text');
    const pulse = dom.window.document.querySelector('.bot-pulse');
    assert.ok(text && pulse, '#bot-status-text et .bot-pulse doivent exister');

    api.renderBotStatus({ running: true, active: 2, restarts: 3, blockedVisits: 7 });
    assert.match(text.innerHTML, /Bot en marche/);
    assert.match(text.innerHTML, /2 cycle\(s\) en cours/);
    assert.match(text.innerHTML, /3 fenêtre\(s\) relancée\(s\)/);
    assert.match(text.innerHTML, /7 blocage\(s\) traversé\(s\)/);
    assert.equal(pulse.classList.contains('is-idle'), false, 'le pouls reste actif');

    api.renderBotStatus({ running: false, active: 0 });
    assert.match(text.innerHTML, /Bot à l’arrêt/);
    assert.equal(pulse.classList.contains('is-idle'), true);
  } finally {
    globalThis.window = previous.window;
    globalThis.document = previous.document;
  }
});

test('thème : la palette sombre cyberpunk reste lisible (contraste AA)', async () => {
  const { readFile } = await import('node:fs/promises');
  const css = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');
  const read = (name) => {
    const match = new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`).exec(css);
    assert.ok(match, `la variable --${name} doit être définie en hexadécimal`);
    return match[1];
  };
  const luminance = (hex) => {
    const channels = [1, 3, 5].map((start) => parseInt(hex.slice(start, start + 2), 16) / 255)
      .map((value) => (value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  };
  const contrast = (a, b) => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };

  const bg = read('bg');
  const surface = read('surface');
  // Le fond doit rester très sombre, sinon ce n'est plus un thème sombre.
  assert.ok(luminance(bg) < 0.02, `fond trop clair : ${bg}`);
  for (const [label, color] of [['texte', read('text')], ['muted', read('muted')], ['accent', read('accent')]]) {
    assert.ok(contrast(color, bg) >= 4.5, `${label} sur fond : contraste insuffisant (${contrast(color, bg).toFixed(2)})`);
    assert.ok(contrast(color, surface) >= 4.5, `${label} sur carte : contraste insuffisant (${contrast(color, surface).toFixed(2)})`);
  }
  // Les accents secondaires servent à des badges : seuil AA pour du texte.
  for (const name of ['cyan', 'magenta', 'violet', 'orange', 'red']) {
    assert.ok(contrast(read(name), bg) >= 4.5, `--${name} insuffisant sur le fond`);
  }
  assert.equal(css.includes('#74efad'), false, 'aucune couleur de l’ancien thème ne subsiste');
});
