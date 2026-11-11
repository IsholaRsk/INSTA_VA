import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Vérifie que la page servie ne référence que des fichiers réellement publiés.
 * Un chemin faux ne casse pas les tests habituels : la page reste « valide »,
 * mais elle est blanche dans le navigateur. C'est exactement le genre d'erreur
 * qu'un déploiement révèle trop tard.
 */
const root = path.resolve(import.meta.dirname, '..');
const publicDir = path.join(root, 'public');

/** Liste récursive des fichiers d'un dossier, en chemins relatifs. */
function listFiles(dir, base = '') {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const relative = base ? path.join(base, entry.name) : entry.name;
    return entry.isDirectory() ? listFiles(path.join(dir, entry.name), relative) : [relative];
  });
}

function referencedAssets(html) {
  const assets = [];
  for (const match of html.matchAll(/(?:src|href)="(\/[^"]+)"/g)) assets.push(match[1]);
  return assets;
}

test('chaque ressource de index.html existe dans public/', () => {
  const html = readFileSync(path.join(publicDir, 'index.html'), 'utf8');
  const assets = referencedAssets(html).filter((asset) => !asset.endsWith('.webmanifest') || true);
  assert.ok(assets.length >= 5, `trop peu de ressources détectées : ${assets.length}`);
  for (const asset of assets) {
    const file = path.join(publicDir, asset.replace(/^\//, ''));
    assert.ok(existsSync(file), `fichier manquant : ${asset}`);
  }
});

test('les modules ES de l’interface se résolvent tous entre eux', () => {
  const appDir = path.join(publicDir, 'app');
  assert.ok(existsSync(appDir), 'public/app doit être publié (node scripts/copy-ui.mjs)');
  const modules = listFiles(appDir).filter((name) => name.endsWith('.js'));
  assert.ok(modules.length >= 10, `modules publiés : ${modules.length}`);

  const missing = [];
  for (const relative of modules) {
    const file = path.join(appDir, relative);
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/from\s+'(\.[^']+)'/g)) {
      const target = path.resolve(path.dirname(file), match[1]);
      if (!existsSync(target)) missing.push(`${relative} → ${match[1]}`);
    }
  }
  assert.deepEqual(missing, [], `imports non résolus : ${missing.join(', ')}`);
});

test('le dossier public/app reflète les sources de ui/src', () => {
  const sources = listFiles(path.join(root, 'ui/src')).sort();
  const published = listFiles(path.join(publicDir, 'app'))
    .filter((name) => name !== 'apercu.svg')
    .sort();
  assert.deepEqual(published, sources, 'public/app doit être régénéré après une modification de ui/src');
});
