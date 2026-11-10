# InstaVA — bot autonome sur VPS, extension Chrome et PWA mobile

L’extension Chrome MV3 de bureau enregistre et lance des cibles URL. Chaque cycle suit un enchaînement fixe — ouvrir l’URL, attendre la stabilisation, cliquer sur le lien ou le bouton indiqué, attendre sa redirection — puis se répète selon le mode choisi. Il n’y a pas de workflow à construire. Les fiches (pseudo, URL, libellé de lien ou de bouton facultatif, nombre de visites, mode et durée) restent dans `chrome.storage.local`. Dans ce mode local, aucun serveur d’automatisation n’est appelé; si l’option proxy est activée, le clic et sa redirection passent par le gateway Webshare fourni par l’utilisateur.

Le dépôt contient **deux façons d’exécuter le même bot**, avec les mêmes règles :

| | Extension Chrome | Bot autonome sur VPS |
|---|---|---|
| Où tourne Chromium | ton ordinateur de bureau | ton serveur, 24 h/24 |
| Contrôle depuis le téléphone | non (les extensions MV3 ne s’installent pas sur Chrome mobile) | **oui**, via une PWA installable |
| Comptes et données | `chrome.storage.local` | base SQLite sur le VPS |
| Identifiants proxy | `chrome.storage.local` | chiffrés AES-256-GCM sur le disque |
| Dépendance externe | aucune | aucune |

Les deux appliquent les mêmes règles : durée en **jours**, clic sur **lien ou bouton** quel que soit le libellé, et **au moins 100 clics par jour** (288 maximum par cible et par jour, écart minimum de 5 minutes).

**Pour l’installation sur un VPS, suis [DEPLOY.md](DEPLOY.md)** : Docker Compose avec Caddy et HTTPS automatique, ou service systemd, variante Tailscale sans domaine, sauvegardes et dépannage.

Le moteur Tesseract.js/WASM et les données française/anglaise sont inclus dans `extension/vendor/`. Les captures et l’OCR restent dans Chrome. L’extension ne lance pas de navigateur séparé et n’exige pas de port de débogage.

Les proxys Webshare ne sont plus limités à une seule entrée : le panneau enregistre une **liste** de proxys **sans limite de nombre**, l’active ou la désactive ligne par ligne et applique un proxy différent à chaque cycle, dans l’ordre ou au hasard.

## Installation

1. Ouvre `chrome://extensions` dans le Chrome à piloter.
2. Active **Mode développeur**.
3. Clique sur **Charger l’extension non empaquetée** et choisis le dossier `extension/`.
4. Accepte les autorisations demandées. **debugger** sert à lire l’écran et cliquer; **proxy** permet l’activation temporaire du gateway; **webRequest** et l’accès aux sites sont utilisés uniquement pour répondre au challenge d’authentification Webshare. Chrome affiche une autorisation d’accès aux sites.
5. Ouvre le panneau latéral de l’extension.

## Utilisation

1. Crée jusqu’à 50 fiches, une par cible, avec un pseudo/alias, une URL HTTP(S), un nombre de visites et, au choix, un libellé de lien ou de bouton. Le libellé est **facultatif** : renseigné, il doit correspondre exactement au texte d’un élément cliquable visible; laissé vide, le bot clique tout seul. Tu n’as pas à ajouter ni ordonner des étapes. Les fiches peuvent être consultées, modifiées ou supprimées.
2. À chaque cycle, le bot ouvre l’URL enregistrée et attend la fin du chargement puis la stabilisation de la page. **Avec un libellé**, il cherche un **lien ou un bouton** visible unique dont le texte correspond (casse, accents et espaces normalisés) et ne clique que si la correspondance est unique — éléments acceptés : `a[href]`, `[role="link"]`, `button`, `input[type="button"]`, `input[type="submit"]`, `[role="button"]` et `summary`. **Sans libellé**, il clique l’élément cliquable visible : s’il n’y en a qu’un, c’est celui-là; sinon il retient l’**élément principal** (plus grande surface à l’écran, avec du texte, hors en-tête/navigation/pied de page, avec une préférence pour les boutons et liens d’action). Il attend ensuite la stabilisation de la redirection et ferme l’onglet temporaire. Si aucun élément cliquable n’existe, ou si plusieurs portent le même libellé, il ne clique pas et le cycle est ignoré. L’OCR reste local.
3. Deux modes, indépendants pour chaque cible :
   - **Intervalle** : un **nombre visé** (sans plafond) réparti sur une **durée de 1 à 365 jours**.
   - **Objectif** : un **nombre cible** (sans plafond) et **aucune durée** — le bot enchaîne exactement ce nombre de visites en une seule fois, avec une pause courte et variable (environ 1,5 à 3,5 s) entre deux visites.

   Les raccourcis **Appliquer à toutes** permettent d’utiliser les mêmes valeurs pour toutes les fiches enregistrées. Le nombre de visites n’est plus limité à 50 (borne technique : 1 000 000). **Le bot fait au moins 100 clics par jour** : si le total demandé est trop faible pour tenir ce rythme sur la durée choisie, il est relevé au minimum de `100 × jours`.
4. La section **Proxys Webshare** remplace l’ancien formulaire unique. Ajoute un proxy à la main (hôte, port, protocole, identifiants) ou colle une liste entière dans **Import en masse**, une ligne par proxy. Formats acceptés : `host:port:user:pass`, `user:pass@host:port`, `socks5://user:pass@host:port` ou simplement `host:port` lorsque tu renseignes l’identifiant et le mot de passe communs sous la zone d’import. Les doublons, les lignes vides, les commentaires `#` et les hôtes locaux ou privés sont ignorés avec un compte rendu. Chaque ligne affiche son état, ses compteurs (cycles, succès, échecs) et le résultat du bouton **Tester** (IP de sortie observée). Décoche **Utiliser la liste des proxys** pour revenir au réglage proxy déjà configuré dans Chrome.
5. Coche les cibles voulues puis clique **Lancer la sélection**. Chaque cible a son propre tirage de nombre et sa propre durée; les cycles de plusieurs cibles sont intercalés selon leurs prochains horaires.

**Mode intervalle** : pour un nombre visé `N` et une durée de `D` jours, le total réellement exécuté est le plus grand entre `N` et `100 × D` — jamais en dessous de **100 clics par jour**. Ce total est réparti équitablement entre les jours (quotient, le reste sur les premiers jours), et chaque jour ne peut pas dépasser **288 clics** (écart minimum de 5 minutes) : le surplus bascule sur les jours suivants. La première exécution commence au lancement, les suivantes sont réparties dans leur journée avec au moins 5 minutes d’écart. Un **journal quotidien** (`chrome.storage.local`, clé `dailyClicks`, conservé 40 jours) compte les clics par jour : si la journée n’a pas atteint son quota, le plan continue jusqu’à l’objectif, et une journée entièrement manquée est rattrapée le lendemain (dans la limite de 100 clics de retard). Les retards de navigation ou de confirmation peuvent décaler des horaires et faire dépasser la durée.

**Mode objectif** : aucune durée ni tirage aléatoire, le nombre cible est exécuté à l'identique, en un seul lot enchaîné. Les arrêts, erreurs ou fermeture du panneau interrompent le lot (la progression n'est pas reprise automatiquement).

La confirmation avant chaque clic est activée par défaut; certains libellés sensibles (payer, envoyer, supprimer, publier…) restent toujours soumis à confirmation, et un clic sans libellé (lien choisi automatiquement) l’est aussi. La confirmation suspend le plan jusqu’à la réponse. **En mode objectif**, une seule confirmation couvre tout le lot, sinon un objectif de plusieurs centaines de visites demanderait autant de fenêtres. Un refus annule la série entière avant le premier clic. Pour une série sans confirmation systématique, décoche cette option; les clics sensibles restent confirmés.

Le proxy du cycle est activé avant l’ouverture de l’URL et reste appliqué pendant le chargement, le clic et la redirection; le réglage proxy précédent de Chrome est restauré à la fin de chaque cycle. `chrome.proxy` agit sur tout le profil Chrome pendant cette fenêtre, pas uniquement sur l’onglet temporaire; d’autres onglets peuvent donc aussi passer par Webshare. Le fournisseur applique sa propre rotation par requête/connexion : une page peut générer plusieurs connexions, donc l’extension ne peut garantir une IP de sortie distincte exactement par clic. Chaque cycle tire le proxy suivant de la liste des proxys **activés** : `dans l’ordre` parcourt la liste puis recommence, `au hasard` tire à chaque fois. Un cycle réussi ou échoué à cause du réseau incrémente les compteurs du proxy; après trois échecs consécutifs, le proxy est automatiquement désactivé et signalé dans la liste (option désactivable). Un cycle sans clic (lien introuvable, ambigu ou ignoré) n’est pas imputé au proxy. Les identifiants restent dans `chrome.storage.local` sur cet appareil, sont chargés dans `chrome.storage.session` juste avant chaque cycle et effacés à la fin de la série; ils ne sont jamais écrits dans les logs. Le trafic routé passe par le fournisseur Webshare.

## Limites et confidentialité

Tesseract est un moteur OCR, pas un modèle de raisonnement. Avec un libellé, la détection est limitée à une correspondance complète et non ambiguë sur un lien visible; sans libellé, le choix du lien principal est une heuristique (surface à l’écran, texte, exclusion de la navigation), pas une compréhension de la page. Vérifie le journal **lien choisi automatiquement** lors des premiers cycles d’une nouvelle page. Les anciens blocs de clic des workflows sont convertis en libellés simples; les anciens blocs d’attente ne sont plus exécutés. Les anciennes durées en semaines enregistrées sont converties en jours (semaines × 7, plafonnées à 365). L’extension ne comprend pas de consigne libre et ne saisit pas de mots de passe ou de codes secrets.

Les fiches persistent localement, mais la planification en cours n’est pas enregistrée comme une alarme d’arrière-plan. Garde Chrome et le panneau latéral ouverts : fermer le panneau ou Chrome arrête la série, sans reprise automatique. Les onglets Chrome préexistants restent ouverts; seuls les onglets temporaires créés par l’extension sont fermés.

Le worker Tesseract.js est démarré à la demande par `ensureOcrWorker()`, servi exclusivement depuis `extension/vendor/` (`worker.min.js`, `tesseract-core-*-lstm.wasm.js`, `lang-data/*.traineddata.gz`) : aucune requête réseau, aucune ressource distante. Le worker est arrêté à la fin de chaque exécution et à la fin de la série. L’OCR relit la capture d’écran pour corroborer la position du lien (journal **OCR concordant**/**OCR sans correspondance**) mais ne décide jamais seul du clic : la détection DOM exacte reste la référence. Si le worker ne peut pas démarrer, le cycle continue et l’erreur est journalisée. Les fichiers OCR tiers et leurs licences sont dans `extension/vendor/`.

Les tests Node couvrent la liste de proxys (analyse des lignes, import, rotation dans l’ordre et au hasard, anti-répétition, compteurs, désactivation automatique, migration du proxy unique), l’interface de gestion des proxys, le rythme quotidien (quota de 100 clics/jour, plafond de 288, répartition sur les jours, journal), la configuration du worker OCR et la cohérence du câblage de l’extension (appel de fonction non déclarée, identifiants HTML, chargement des scripts, ressources du manifeste) : `npm test`.

## Bot autonome sur VPS et contrôle depuis le téléphone

L’extension MV3 ne s’installe pas dans Chrome mobile. Pour piloter le bot depuis un iPhone ou un Android, le dépôt fournit un **serveur autonome** (`server/`) qui exécute les cycles jour et nuit et sert une **PWA installable**.

### Ce que fait le serveur

- **Exécution** : Playwright ouvre l’URL de la cible, attend la stabilisation, clique le **lien ou le bouton** dont le libellé correspond exactement (ou l’élément principal si le libellé est vide), puis attend la redirection.
- **Planification** : une boucle interne vérifie les visites dues toutes les 5 secondes. Aucun cron externe n’est nécessaire.
- **Rythme** : chaque visite réussie est comptée dans un **journal quotidien** (`daily_clicks`). Le bot tient au moins **100 clics par jour** par cible sur la durée choisie, plafonne à **288 clics par jour** (5 minutes d’écart) et rattrape le lendemain une journée manquée, dans la limite de 100 clics.
- **Données** : base **SQLite** dans `DATA_DIR` (`node:sqlite`, aucune dépendance native à compiler). Les visites et l’historique sont consultables depuis l’application.
- **Comptes** : inscription locale, mots de passe hachés avec **scrypt**, sessions opaques en cookie `HttpOnly`/`SameSite=Strict`/`Secure`, dont seul le SHA-256 est stocké.
- **Proxy** : **liste sans limite de nombre** (69, 200, autant que tu veux), une ligne par proxy au format `hôte:port:identifiant:motdepasse` ou `identifiant:motdepasse@hôte:port`. Chaque cycle prend le proxy suivant, dans l'ordre ou au hasard sans répétition immédiate ; un proxy qui échoue trois fois de suite est écarté automatiquement, et le bouton **Tester** affiche l'IP de sortie de chaque proxy. Identifiants chiffrés **AES-256-GCM** sur le disque, jamais renvoyés au navigateur ni journalisés. Les bases existantes migrent automatiquement : l'ancien proxy unique devient le premier de la liste.
- **Sécurité réseau** : chaque URL chargée (navigation, sous-ressources, destination du clic) est vérifiée ; les adresses privées et locales sont bloquées en permanence.
- **Sites protégés** : User-Agent et *client hints* alignés sur la version réelle du moteur, `navigator.webdriver` neutralisé, attente du challenge Cloudflare (15 s) et repli automatique par proxy. Voir le chapitre 8 bis de [DEPLOY.md](DEPLOY.md).

### L’application mobile

La PWA de `public/` sert d’écran de contrôle : connexion, création et modification des cibles, choix du mode (intervalle en jours ou objectif), lancement, arrêt, bouton **Confirmer & cliquer** pour les clics sensibles, et le **journal quotidien** en barres montrant les 14 derniers jours.

Sur iPhone : Safari → Partager → *Sur l’écran d’accueil*. Sur Android : Chrome → menu ⋮ → *Installer l’application*. La page se rafraîchit toutes les 15 secondes quand elle est visible ; le bot, lui, continue de tourner quand l’application est fermée.

### Configuration

Toutes les variables sont décrites dans [`.env.example`](.env.example). Les plus importantes :

| Variable | Rôle | Défaut |
|---|---|---|
| `INSTAVA_DOMAIN` | domaine servi par Caddy (Docker) | — (obligatoire) |
| `DATA_DIR` | base SQLite et `secret.key` | `./data` |
| `INSTAVA_TZ` | fuseau des quotas quotidiens | `Africa/Porto-Novo` |
| `INSTAVA_SECRET_KEY` | clé de chiffrement des proxys | générée au premier démarrage |
| `INSTAVA_SIGNUP_CODE` | code d’invitation à l’inscription | vide (inscriptions ouvertes) |
| `INSTAVA_CONCURRENCY` | cycles Chromium simultanés | `2` |

### Installation

Tout est détaillé dans **[DEPLOY.md](DEPLOY.md)** : préparation du VPS, Docker Compose, Caddy et HTTPS automatique, variante systemd, mode Tailscale sans domaine, sauvegardes et dépannage.

En résumé, sur un VPS avec un domaine pointé vers lui :

```bash
git clone https://github.com/IsholaRsk/INSTA_VA.git /opt/instava
cd /opt/instava && cp .env.example .env && nano .env
docker compose up -d --build
```

Puis ouvre `https://bot.tondomaine.fr` depuis le téléphone et crée le compte propriétaire.

### Développement local

```bash
npm ci
DATA_DIR=./data INSTAVA_LOG_LEVEL=debug npm start
```

`http://localhost:8080` sert l’application ; les données restent dans `./data` (ignoré par Git). Sans Chromium installé, l’interface et l’API fonctionnent, mais les cycles échouent au lancement du navigateur : `npx playwright install --with-deps chromium` pour l’activer.

### Tests

```bash
npm test     # 55+ tests : API, moteur, planification, chiffrement, sécurité
npm run check  # vérification syntaxique de tous les fichiers
```

## Ancienne architecture (Vercel + Supabase) — conservée pour référence

Les dossiers `api/`, `lib/`, `supabase/` et `vercel.json` correspondent à la version précédente : fonctions serverless sur Vercel, authentification et base sur Supabase, secrets proxy dans Supabase Vault, cron `*/5 * * * *`.

**Ils ne sont plus utilisés par le bot.** Le serveur autonome de `server/` remplace l’ensemble : base SQLite, comptes locaux, chiffrement AES-256-GCM sur disque et planificateur interne toutes les 5 secondes (plus précis qu’un cron Vercel, et sans limite de plan d’hébergement).

Ces fichiers restent dans le dépôt pour que l’historique soit lisible et pour faciliter une éventuelle migration de données depuis Supabase. Si tu ne t’en sers pas, tu peux les supprimer sans impact sur le bot.

> La migration SQL `supabase/migrations/202611070001_create_instava_mobile_runner.sql` n’est **plus nécessaire** : le schéma SQLite est créé automatiquement au premier démarrage du serveur.

Pour les tests syntaxiques du dépôt, exécute `npm run check`. Aucun identifiant utilisateur ou compte Webshare n’est fourni avec le dépôt.
