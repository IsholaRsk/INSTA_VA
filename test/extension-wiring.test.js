import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const files = ['extension/bot-utils.js', 'extension/sidepanel.js', 'extension/service_worker.js'];
const sources = new Map(files.map((file) => [file, readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')]));

/** Tous les noms déclarés par un fichier de l'extension (fonctions, variables, paramètres de haut niveau). */
function declaredNames(source) {
  const names = new Set();
  const patterns = [
    /\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/g,
    // paramètres de fonctions fléchées et de fonctions classiques : (a, b) => / function (a)
    /\(([^()]*)\)\s*=>/g,
    /\bfunction\s*[A-Za-z_$]*\s*\(([^()]*)\)/g,
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g,
    // destructuration : const { a, b: c } = …
    /\b(?:const|let|var)\s*\{([^}]*)\}\s*=/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      if (pattern.source.includes('=>') || pattern.source.includes('function\\s*[A-Za-z_$]*')) {
        for (const part of match[1].split(',')) {
          const name = part.split('=')[0].trim();
          if (/^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
        }
      } else if (pattern.source.includes('\\{')) {
        for (const part of match[1].split(',')) {
          const name = part.split(':').pop().trim().split('=')[0].trim();
          if (/^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
        }
      } else {
        names.add(match[1]);
      }
    }
  }
  return names;
}

const sharedGlobals = new Set([
  // JavaScript / Web / Chrome
  'if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'function', 'new', 'await', 'async', 'do', 'else', 'try',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'fetch', 'atob', 'btoa', 'queueMicrotask',
  'structuredClone', 'createImageBitmap', 'Blob', 'File', 'URL', 'URLSearchParams', 'AbortController', 'AbortSignal',
  'Response', 'Request', 'Headers', 'TextDecoder', 'TextEncoder', 'Uint8Array', 'Uint32Array', 'Array', 'Object',
  'Number', 'String', 'Boolean', 'Math', 'JSON', 'Promise', 'Date', 'Set', 'Map', 'WeakMap', 'Error', 'TypeError',
  'RangeError', 'RegExp', 'Symbol', 'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'encodeURIComponent',
  'decodeURIComponent', 'console', 'crypto', 'chrome', 'Tesseract', 'Worker', 'Image', 'navigator', 'document',
  'window', 'self', 'globalThis', 'requestAnimationFrame', 'alert', 'confirm', 'prompt', 'importScripts', 'module',
  'require', 'define', 'exports', 'process', 'WebAssembly', 'performance', 'CustomEvent', 'Event', 'FormData',
]);

/**
 * Retire commentaires, chaînes et littéraux RegExp pour ne garder que le code.
 * Un simple scanner caractère par caractère évite les faux positifs des regex globales.
 */
function stripLiterals(source) {
  let out = '';
  let index = 0;
  let lastMeaningful = '';

  // `stop` : caractère qui termine le mode courant ("`" pour un gabarit, null hors gabarit).
  function readTemplate() {
    index += 1; // backtick ouvrant
    while (index < source.length) {
      const char = source[index];
      if (char === '\\') { index += 2; continue; }
      if (char === '`') { index += 1; return; }
      if (char === '$' && source[index + 1] === '{') {
        index += 2;
        const mark = out.length;
        readCode('}');
        out = out.slice(0, mark); // le code interpolé n'est pas du code appelant
        continue;
      }
      index += 1;
    }
  }

  function readCode(terminator) {
    let depth = 0;
    while (index < source.length) {
      const char = source[index];
      const next = source[index + 1];
      if (terminator && char === terminator && depth === 0) { index += 1; return; }
      if (char === '/' && next === '/') { while (index < source.length && source[index] !== '\n') index += 1; continue; }
      if (char === '/' && next === '*') {
        index += 2;
        while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) index += 1;
        index += 2;
        continue;
      }
      if (char === '"' || char === "'") {
        index += 1;
        while (index < source.length && source[index] !== char) {
          if (source[index] === '\\') index += 1;
          index += 1;
        }
        index += 1;
        out += ' ';
        lastMeaningful = char;
        continue;
      }
      if (char === '`') { readTemplate(); out += ' '; lastMeaningful = '`'; continue; }
      if (char === '/' && /[=(,:!&|?{};[\n]|^$/.test(lastMeaningful)) {
        index += 1;
        let inClass = false;
        while (index < source.length) {
          const current = source[index];
          if (current === '\\') { index += 2; continue; }
          if (current === '[') inClass = true;
          else if (current === ']') inClass = false;
          else if (current === '/' && !inClass) break;
          else if (current === '\n') break;
          index += 1;
        }
        index += 1;
        out += ' ';
        lastMeaningful = '/';
        continue;
      }
      if (char === '{' || char === '(' || char === '[') depth += 1;
      if (char === '}' || char === ')' || char === ']') depth -= 1;
      out += char;
      if (!/\s/.test(char)) lastMeaningful = char;
      index += 1;
    }
  }

  readCode(null);
  return out;
}

test('extension scripts never call an undeclared function', () => {
  const allDeclared = new Set(sharedGlobals);
  for (const source of sources.values()) {
    for (const name of declaredNames(source)) allDeclared.add(name);
  }

  const problems = [];
  for (const [file, source] of sources) {
    const stripped = stripLiterals(source);
    const callPattern = /(^|[^.\w$'"`])([A-Za-z_$][\w$]*)\s*\(/g;
    for (const match of stripped.matchAll(callPattern)) {
      const name = match[2];
      if (allDeclared.has(name)) continue;
      if (/^(if|for|while|switch|catch|return|typeof|function|new|await|async|do|else|try|delete|void|in|of|instanceof)$/.test(name)) continue;
      problems.push(`${file}: appel à « ${name}( » non déclaré`);
    }
  }

  assert.deepEqual([...new Set(problems)], [], `Fonctions manquantes :\n${[...new Set(problems)].join('\n')}`);
});

test('the side panel loads its shared helper before sidepanel.js', () => {
  const html = readFileSync(new URL('../extension/sidepanel.html', import.meta.url), 'utf8');
  const utilsIndex = html.indexOf('<script src="bot-utils.js"></script>');
  const panelIndex = html.indexOf('<script src="sidepanel.js"></script>');
  assert.ok(utilsIndex >= 0, 'bot-utils.js doit être inclus dans le panneau');
  assert.ok(panelIndex > utilsIndex, 'bot-utils.js doit être chargé avant sidepanel.js');
  assert.ok(html.includes('vendor/tesseract.min.js'), 'le moteur OCR local doit être inclus');
});

test('every element id used by sidepanel.js exists in sidepanel.html', () => {
  const html = readFileSync(new URL('../extension/sidepanel.html', import.meta.url), 'utf8');
  const source = sources.get('extension/sidepanel.js');
  const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]));
  const used = new Set([...source.matchAll(/\$\("([^"]+)"\)/g)].map((match) => match[1]));
  const missing = [...used].filter((id) => !ids.has(id));
  assert.deepEqual(missing, [], `Identifiants absents du HTML : ${missing.join(', ')}`);
});

test('manifest keeps the OCR worker assets reachable and the vendor bundle local', () => {
  const manifest = JSON.parse(readFileSync(new URL('../extension/manifest.json', import.meta.url), 'utf8'));
  const resources = (manifest.web_accessible_resources || []).flatMap((entry) => entry.resources || []);
  const joined = resources.join(' ');
  for (const needed of ['vendor/worker.min.js', 'vendor/tesseract-core-*.wasm.js', 'vendor/lang-data/*']) {
    assert.ok(joined.includes(needed), `${needed} doit rester accessible`);
  }
  assert.match(manifest.content_security_policy.extension_pages, /worker-src 'self'/);
  assert.match(manifest.content_security_policy.extension_pages, /wasm-unsafe-eval/);
  assert.ok(manifest.permissions.includes('proxy'), 'permission proxy requise pour la rotation');
  assert.ok(manifest.permissions.includes('webRequestAuthProvider'), 'authentification proxy requise');
});
