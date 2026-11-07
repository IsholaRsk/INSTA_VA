# InstaVA — extension Chrome et PWA mobile

L’extension Chrome MV3 de bureau enregistre et lance des cibles URL. Chaque cycle suit un enchaînement fixe — ouvrir l’URL, attendre la stabilisation, cliquer sur le lien indiqué, attendre sa redirection — puis se répète selon le mode intervalle. Il n’y a pas de workflow à construire. Les fiches (pseudo, URL, libellé du lien, nombre visé et durée en semaines) restent dans `chrome.storage.local`. Dans ce mode local, aucun serveur d’automatisation n’est appelé; si l’option proxy est activée, le clic et sa redirection passent par le gateway Webshare fourni par l’utilisateur.

Une PWA distincte est fournie pour l’utilisation depuis l’écran d’accueil d’un iPhone ou d’un téléphone Android. Comme les extensions MV3 ne s’installent pas directement dans Chrome mobile, la PWA délègue les cycles à un navigateur Chromium distant et à un worker planifié. Les URL et libellés y sont donc traités par le serveur configuré.

Le moteur Tesseract.js/WASM et les données française/anglaise sont inclus dans `extension/vendor/`. Les captures et l’OCR restent dans Chrome. L’extension ne lance pas de navigateur séparé et n’exige pas de port de débogage.

Les proxys Webshare ne sont plus limités à une seule entrée : le panneau enregistre une **liste** de proxys (jusqu’à 100), l’active ou la désactive ligne par ligne et applique un proxy différent à chaque cycle, dans l’ordre ou au hasard.

## Installation

1. Ouvre `chrome://extensions` dans le Chrome à piloter.
2. Active **Mode développeur**.
3. Clique sur **Charger l’extension non empaquetée** et choisis le dossier `extension/`.
4. Accepte les autorisations demandées. **debugger** sert à lire l’écran et cliquer; **proxy** permet l’activation temporaire du gateway; **webRequest** et l’accès aux sites sont utilisés uniquement pour répondre au challenge d’authentification Webshare. Chrome affiche une autorisation d’accès aux sites.
5. Ouvre le panneau latéral de l’extension.

## Utilisation

1. Crée jusqu’à 50 fiches, une par cible, avec un pseudo/alias, une URL HTTP(S), le libellé complet du lien à cliquer, un nombre visé et une durée de 1 à 52 semaines. Tu n’as pas à ajouter ni ordonner des étapes. Les fiches peuvent être consultées, modifiées ou supprimées.
2. À chaque cycle, le bot ouvre l’URL enregistrée et attend la fin du chargement puis la stabilisation de la page. Il cherche un lien visible unique (`a[href]` ou rôle `link`) dont le libellé correspond au texte fourni (casse, accents et espaces normalisés), clique une fois, attend la stabilisation de la redirection et ferme l’onglet temporaire. Si le lien est absent ou ambigu, il ne clique pas. L’OCR reste local.
3. Les champs **Nombre visé** et **Durée (semaines)** définissent le mode intervalle indépendamment pour chaque cible. Les raccourcis **Appliquer à toutes** permettent d’utiliser les mêmes valeurs pour toutes les fiches enregistrées.
4. La section **Proxys Webshare** remplace l’ancien formulaire unique. Ajoute un proxy à la main (hôte, port, protocole, identifiants) ou colle une liste entière dans **Import en masse**, une ligne par proxy. Formats acceptés : `host:port:user:pass`, `user:pass@host:port`, `socks5://user:pass@host:port` ou simplement `host:port` lorsque tu renseignes l’identifiant et le mot de passe communs sous la zone d’import. Les doublons, les lignes vides, les commentaires `#` et les hôtes locaux ou privés sont ignorés avec un compte rendu. Chaque ligne affiche son état, ses compteurs (cycles, succès, échecs) et le résultat du bouton **Tester** (IP de sortie observée). Décoche **Utiliser la liste des proxys** pour revenir au réglage proxy déjà configuré dans Chrome.
5. Coche les cibles voulues puis clique **Lancer la sélection**. Chaque cible a son propre tirage de nombre et sa propre durée; les cycles de plusieurs cibles sont intercalés selon leurs prochains horaires.

Pour un nombre visé `N`, le total réel est tiré indépendamment pour chaque cible parmi les entiers de `max(1, N−10)` à `N+10`. La première exécution commence au lancement; les suivantes sont réparties aléatoirement sur la durée propre à cette cible (1 à 52 semaines), avec au moins 5 minutes entre ses exécutions. Les retards de navigation ou de confirmation peuvent décaler des horaires et faire dépasser la durée. La sélection est limitée à 300 visites potentielles au total, en comptant le pire cas `N+10` pour chaque cible.

La confirmation avant chaque clic est activée par défaut; certains libellés sensibles (payer, envoyer, supprimer, publier…) restent toujours soumis à confirmation. La confirmation suspend le plan jusqu’à la réponse. Pour une série sans confirmation systématique, décoche cette option; les clics sensibles restent confirmés.

Le proxy du cycle est activé avant l’ouverture de l’URL et reste appliqué pendant le chargement, le clic et la redirection; le réglage proxy précédent de Chrome est restauré à la fin de chaque cycle. `chrome.proxy` agit sur tout le profil Chrome pendant cette fenêtre, pas uniquement sur l’onglet temporaire; d’autres onglets peuvent donc aussi passer par Webshare. Le fournisseur applique sa propre rotation par requête/connexion : une page peut générer plusieurs connexions, donc l’extension ne peut garantir une IP de sortie distincte exactement par clic. Chaque cycle tire le proxy suivant de la liste des proxys **activés** : `dans l’ordre` parcourt la liste puis recommence, `au hasard` tire à chaque fois. Un cycle réussi ou échoué à cause du réseau incrémente les compteurs du proxy; après trois échecs consécutifs, le proxy est automatiquement désactivé et signalé dans la liste (option désactivable). Un cycle sans clic (lien introuvable, ambigu ou ignoré) n’est pas imputé au proxy. Les identifiants restent dans `chrome.storage.local` sur cet appareil, sont chargés dans `chrome.storage.session` juste avant chaque cycle et effacés à la fin de la série; ils ne sont jamais écrits dans les logs. Le trafic routé passe par le fournisseur Webshare.

## Limites et confidentialité

Tesseract est un moteur OCR, pas un modèle de raisonnement. La détection du lien est limitée à une correspondance complète et non ambiguë sur un lien visible. Les cibles enregistrées avant cette version sans libellé de lien devront être modifiées avant le lancement. Les anciens blocs de clic des workflows sont convertis en libellés simples; les anciens blocs d’attente ne sont plus exécutés. Les anciennes durées en jours sont converties en semaines par arrondi supérieur (jours ÷ 7). L’extension ne comprend pas de consigne libre et ne saisit pas de mots de passe ou de codes secrets.

Les fiches persistent localement, mais la planification en cours n’est pas enregistrée comme une alarme d’arrière-plan. Garde Chrome et le panneau latéral ouverts : fermer le panneau ou Chrome arrête la série, sans reprise automatique. Les onglets Chrome préexistants restent ouverts; seuls les onglets temporaires créés par l’extension sont fermés.

Le worker Tesseract.js est démarré à la demande par `ensureOcrWorker()`, servi exclusivement depuis `extension/vendor/` (`worker.min.js`, `tesseract-core-*-lstm.wasm.js`, `lang-data/*.traineddata.gz`) : aucune requête réseau, aucune ressource distante. Le worker est arrêté à la fin de chaque exécution et à la fin de la série. L’OCR relit la capture d’écran pour corroborer la position du lien (journal **OCR concordant**/**OCR sans correspondance**) mais ne décide jamais seul du clic : la détection DOM exacte reste la référence. Si le worker ne peut pas démarrer, le cycle continue et l’erreur est journalisée. Les fichiers OCR tiers et leurs licences sont dans `extension/vendor/`.

Les tests Node couvrent la liste de proxys (analyse des lignes, import, rotation, compteurs, désactivation automatique), la configuration du worker OCR et la cohérence du câblage de l’extension (appel de fonction non déclarée, identifiants HTML, chargement des scripts, ressources du manifeste) : `npm test`.

## Adaptation mobile (iPhone et Android)

La PWA se trouve dans `public/` (`index.html`, `app.js`, `styles.css`, manifeste, icônes et service worker); Vercel publie ce dossier comme sortie statique. Sur iPhone, ouvre l’URL de l’application dans Safari puis **Partager → Sur l’écran d’accueil**. Sur Android, ouvre-la dans Chrome puis choisis **Installer l’application** ou **Ajouter à l’écran d’accueil**. L’interface reste utilisable dans un navigateur mobile même sans installation.

Le serveur (`api/`) fournit l’authentification Supabase, la gestion des cibles, la planification, les confirmations et l’exécution Playwright/Chromium. Les secrets Webshare ne sont jamais renvoyés au navigateur : l’API les écrit dans Supabase Vault et les déchiffre uniquement au moment d’un cycle. Dans le worker distant, le proxy s’applique à toute la visite du navigateur (ouverture, ressources, clic et redirection); il ne peut pas être basculé uniquement autour du clic comme dans l’extension locale. L’application utilise toujours le cycle fixe : ouvrir l’URL, attendre la stabilisation, rechercher un lien `a[href]` ou `role=link` visible dont le libellé complet correspond (casse, accents et espaces normalisés), ne cliquer que si la correspondance est unique, puis attendre une redirection. Aucun mot de passe de site ni code secret n’est saisi. Les liens sensibles ou l’option de confirmation activée exigent une validation explicite dans l’app.

Les paramètres par cible restent ceux de l’extension : nombre réel tiré entre `max(1, N−10)` et `N+10`, premier cycle dû dès le lancement, durée indépendante de 1 à 52 semaines, délai minimum de cinq minutes entre deux cycles d’une même cible et maximum de 300 visites potentielles par lancement. Une seule session cloud active est autorisée par compte à la fois. Les visites non traitées restent en file côté serveur lorsque l’app est fermée. Une exécution déjà en cours peut terminer après la demande d’arrêt; les visites en attente sont annulées.

### Déploiement requis

Le dépôt contient le frontend et les fonctions, mais **aucun déploiement cloud ni aucune migration n’est exécuté automatiquement**. Pour activer la PWA, un projet Supabase et un projet d’hébergement serverless doivent être explicitement choisis et configurés. Applique `supabase/migrations/202611070001_create_instava_mobile_runner.sql` au projet Supabase choisi, puis définis ces variables côté serveur de l’hébergeur (jamais dans Git ni dans les champs client) :

- `SUPABASE_URL` — URL du projet Supabase.
- `SUPABASE_ANON_KEY` — clé publique/publishable Supabase; elle est exposée par `/api/config` pour l’authentification du navigateur.
- `SUPABASE_SERVICE_ROLE_KEY` — clé secrète Supabase réservée au serveur; elle ne doit jamais être exposée au navigateur.
- `CRON_SECRET` — valeur aléatoire forte; Vercel Cron doit l’envoyer dans `Authorization: Bearer …`.

Les comptes mobiles utilisent Supabase Auth par e-mail et mot de passe; selon la configuration Auth, une confirmation par e-mail peut être nécessaire. Le coffre de secrets utilise l’extension `supabase_vault` et des fonctions SQL limitées au rôle `service_role`. Ne colle jamais les identifiants Webshare dans le dépôt, un ticket ou le chat : saisis-les dans le formulaire Webshare de la PWA.

`vercel.json` demande un passage de worker toutes les cinq minutes. Cette cadence est nécessaire pour garder une capacité suffisante et réduire les retards, mais Vercel Hobby impose une fréquence minimale de 15 minutes et du jitter; il ne satisfait donc pas cette cadence. Le projet candidat et son plan doivent être vérifiés avant le déploiement, et un plan compatible (ou un worker externe équivalent) peut avoir un coût. Le worker ne rend pas les horaires en arrière-plan aussi précis qu’une tâche locale toujours active : les heures dues sont respectées avec retard si l’hébergeur tarde. Le premier cycle de jusqu’à deux cibles sélectionnées est tenté par la requête de lancement; les autres premières visites sont immédiatement mises en file.

Pour les tests syntaxiques du dépôt, exécute `npm run check`. Le lancement local nécessite les variables serveur ci-dessus et un runtime Vercel compatible. Aucun identifiant utilisateur ou compte Webshare n’est fourni avec le dépôt.
