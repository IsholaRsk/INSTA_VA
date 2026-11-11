/**
 * Copie l'interface React vers le dossier servi par le serveur.
 *
 * Pourquoi une copie et pas un build : le VPS exécute `npm ci --omit=dev` dans
 * l'image Docker, donc aucune dépendance de construction n'y est disponible.
 * Les sources sont du JavaScript directement exécutable par le navigateur, il
 * suffit de les publier sous /app.
 */
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const source = path.join(root, 'ui', 'src');
const target = path.join(root, 'public', 'app');

rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
cpSync(source, target, { recursive: true });

// theme.css reste à sa place dans public/app : le HTML le charge depuis là.
console.log(`Interface publiée : ${path.relative(root, target)}`);
