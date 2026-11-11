# Interface React

Interface principale du bot, servie à la racine par `server/index.js`.

## Pourquoi du JavaScript sans compilation

Le VPS construit son image avec `npm ci --omit=dev` : aucun outil de build n'y
est disponible. Les sources sont donc du JavaScript exécutable tel quel par le
navigateur, et React est servi en local depuis `public/vendor/` — la CSP du
serveur n'autorise que `script-src 'self'`.

## Modifier l'interface

```bash
# 1. éditer ui/src/…
# 2. publier vers le dossier servi
node scripts/copy-ui.mjs
```

`public/app` est une copie de `ui/src`. Un test (`test/ui-assets.test.js`)
échoue si les deux divergent : oublier la publication est détecté avant le
déploiement.

## Structure

- `src/App.js` — l'application, ses onglets et son état.
- `src/api.js` — accès à l'API du bot, requêtes relatives uniquement.
- `src/lib.js` — pont minimal vers React (`h`, hooks), sans import.
- `src/domain/earnings.js` — le barème, pur et testé.
- `src/components/` — carte de solde, actions, listes, navigation, écrans.
- `src/theme.css` — thème sombre et responsive.
