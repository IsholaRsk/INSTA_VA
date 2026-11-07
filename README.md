# Agent visuel local pour le Chrome déjà ouvert

Extension Chrome MV3 pour enregistrer et lancer des cibles URL. Chaque cycle suit un enchaînement fixe — ouvrir l’URL, attendre la stabilisation, cliquer sur le lien indiqué, attendre sa redirection — puis se répète selon le mode intervalle. Il n’y a pas de workflow à construire. Les fiches (pseudo, URL, libellé du lien, nombre visé et durée en semaines) restent dans `chrome.storage.local`. Aucun serveur d’automatisation ni API Webshare n’est appelé; si l’option proxy est activée, le clic et sa redirection passent par le gateway Webshare fourni par l’utilisateur.

Le moteur Tesseract.js/WASM et les données française/anglaise sont inclus dans `extension/vendor/`. Les captures et l’OCR restent dans Chrome. L’extension ne lance pas de navigateur séparé et n’exige pas de port de débogage.

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
4. L’option **Proxy Webshare rotatif** est activée par défaut. Pour l’utiliser, renseigne l’hôte, le port, le protocole et les identifiants indiqués dans ton compte Webshare; ils ne sont conservés que dans le stockage de session pendant l’exécution. Décoche l’option pour utiliser le réglage proxy déjà configuré dans Chrome.
5. Coche les cibles voulues puis clique **Lancer la sélection**. Chaque cible a son propre tirage de nombre et sa propre durée; les cycles de plusieurs cibles sont intercalés selon leurs prochains horaires.

Pour un nombre visé `N`, le total réel est tiré indépendamment pour chaque cible parmi les entiers de `max(1, N−10)` à `N+10`. La première exécution commence au lancement; les suivantes sont réparties aléatoirement sur la durée propre à cette cible (1 à 52 semaines), avec au moins 5 minutes entre ses exécutions. Les retards de navigation ou de confirmation peuvent décaler des horaires et faire dépasser la durée. La sélection est limitée à 300 visites potentielles au total, en comptant le pire cas `N+10` pour chaque cible.

La confirmation avant chaque clic est activée par défaut; certains libellés sensibles (payer, envoyer, supprimer, publier…) restent toujours soumis à confirmation. La confirmation suspend le plan jusqu’à la réponse. Pour une série sans confirmation systématique, décoche cette option; les clics sensibles restent confirmés.

Le gateway Webshare est activé juste avant le clic et le réglage proxy précédent est restauré après stabilisation de la redirection. `chrome.proxy` agit sur tout le profil Chrome pendant cette fenêtre, pas uniquement sur l’onglet temporaire; d’autres onglets peuvent donc aussi passer par Webshare. Le gateway Webshare applique sa propre rotation par requête/connexion : une page peut générer plusieurs connexions, donc l’extension ne peut garantir une IP de sortie distincte exactement par clic. Les identifiants ne sont pas écrits dans `chrome.storage.local` ni dans les logs; ils restent dans `chrome.storage.session` jusqu’à la fin de la série. Le trafic routé passe par le fournisseur Webshare.

## Limites et confidentialité

Tesseract est un moteur OCR, pas un modèle de raisonnement. La détection du lien est limitée à une correspondance complète et non ambiguë sur un lien visible. Les cibles enregistrées avant cette version sans libellé de lien devront être modifiées avant le lancement. Les anciens blocs de clic des workflows sont convertis en libellés simples; les anciens blocs d’attente ne sont plus exécutés. Les anciennes durées en jours sont converties en semaines par arrondi supérieur (jours ÷ 7). L’extension ne comprend pas de consigne libre et ne saisit pas de mots de passe ou de codes secrets.

Les fiches persistent localement, mais la planification en cours n’est pas enregistrée comme une alarme d’arrière-plan. Garde Chrome et le panneau latéral ouverts : fermer le panneau ou Chrome arrête la série, sans reprise automatique. Les onglets Chrome préexistants restent ouverts; seuls les onglets temporaires créés par l’extension sont fermés.

Les fichiers OCR tiers et leurs licences sont dans `extension/vendor/`.
