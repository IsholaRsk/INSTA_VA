# Agent visuel local pour le Chrome déjà ouvert

Extension Chrome MV3 pour enregistrer des cibles URL, en sélectionner plusieurs au lancement, attendre leurs redirections et cliquer facultativement sur un bouton identifié par son libellé OCR. Les fiches (pseudo, URL, libellé, nombre visé et durée) sont conservées dans `chrome.storage.local`, dans le profil Chrome; aucun serveur ni compte API n’est utilisé.

Le moteur Tesseract.js/WASM et les données française/anglaise sont inclus dans `extension/vendor/`. Les captures et l’OCR restent dans Chrome. L’extension ne lance pas de navigateur séparé et n’exige pas de port de débogage.

## Installation

1. Ouvre `chrome://extensions` dans le Chrome à piloter.
2. Active **Mode développeur**.
3. Clique sur **Charger l’extension non empaquetée** et choisis le dossier `extension/`.
4. Accepte les autorisations demandées, notamment **debugger** pour capturer les pages et cliquer sur des coordonnées OCR.
5. Ouvre le panneau latéral de l’extension.

## Utilisation

1. Crée jusqu’à 50 fiches, une par cible, avec un pseudo/alias, une URL HTTP(S), le libellé complet d’un lien facultatif, un nombre visé et une durée en jours. Les fiches peuvent être consultées, modifiées ou supprimées.
2. Le bot ouvre directement l’URL et attend qu’elle se stabilise. Si un libellé complet est fourni, l’OCR local lit l’écran puis l’extension vérifie qu’un seul lien visible (lien HTML ou rôle `link`) a exactement ce libellé. Elle clique ce lien, attend la redirection puis ferme l’onglet temporaire. Si le libellé est vide, elle attend simplement la redirection et ferme l’onglet sans lancer l’OCR.
3. Les raccourcis **Appliquer à toutes** permettent de donner le même nombre visé ou la même durée à toutes les fiches enregistrées; les valeurs peuvent ensuite être personnalisées par cible.
4. Coche les cibles voulues puis clique **Lancer la sélection**. Chaque cible a son propre tirage de nombre et sa propre durée; les exécutions des différentes cibles sont intercalées selon leurs prochains horaires.

Pour un nombre visé `N`, le total réel est tiré indépendamment pour chaque cible dans les entiers de `max(1, N−10)` à `N+10`. La première exécution démarre au lancement; les suivantes sont distribuées aléatoirement sur la durée enregistrée pour cette cible (1 à 30 jours), avec au moins 5 minutes entre ses exécutions. Les retards de navigation ou de confirmation peuvent décaler des horaires et faire dépasser la durée. La sélection est limitée à 300 visites potentielles au total, en comptant le pire cas `N+10` pour chaque cible.

La confirmation avant chaque clic est activée par défaut; certains libellés sensibles (payer, envoyer, supprimer, publier…) restent toujours soumis à confirmation. Un clic qui attend une confirmation suspend le plan jusqu’à la réponse.

## Limites et confidentialité

Tesseract est un moteur OCR, pas un modèle de raisonnement. Il lit le texte visible; le clic exige ensuite une correspondance complète et non ambiguë sur un lien visible. Une cible sans lien exact ou avec plusieurs liens portant le même libellé est fermée sans clic. L’extension ne comprend pas de consigne libre et ne saisit pas de mots de passe ou de codes secrets.

Les fiches persistent localement, mais la planification en cours n’est pas enregistrée comme une alarme d’arrière-plan. Garde Chrome et le panneau latéral ouverts : fermer le panneau ou Chrome arrête la série, sans reprise automatique. Les onglets Chrome préexistants restent ouverts; seuls les onglets temporaires créés par l’extension sont fermés.

Les fichiers OCR tiers et leurs licences sont dans `extension/vendor/`.
