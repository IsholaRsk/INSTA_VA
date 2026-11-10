# Déployer le bot InstaVA sur un VPS

Ce guide installe le bot **et son interface mobile** sur ton propre serveur. À la fin, tu ouvres `https://bot.tondomaine.fr` depuis ton téléphone, tu installes l'application sur l'écran d'accueil, et le bot continue de cliquer même quand ton téléphone est éteint.

Tout tient sur un seul serveur : Node.js, Chromium, une base SQLite. **Aucun service cloud payant, aucun compte Supabase.**

---

## 1. Ce dont tu as besoin

| Élément | Détail |
|---|---|
| VPS | 2 vCPU, 2 Go de RAM minimum (Chromium est gourmand). Ubuntu 22.04/24.04 ou Debian 12. |
| Disque | 20 Go suffisent largement. |
| Domaine | Un nom de domaine dont tu peux modifier les DNS (ex. `bot.tondomaine.fr`). |
| Accès | SSH avec `sudo` sur le serveur. |

> **Sans domaine ?** Va directement à la [section 7 (Tailscale)](#7-variante-sans-domaine--tailscale). Ton bot ne sera alors accessible que depuis tes appareils, ce qui est encore plus sûr.

---

## 2. Préparer le serveur

```bash
ssh root@sous-domaine-ou-ip
apt update && apt upgrade -y
apt install -y curl git ufw

# Pare-feu : SSH + HTTP/HTTPS uniquement.
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw enable
```

Crée un utilisateur non privilégié pour le service :

```bash
adduser --disabled-password --gecos "" instava
usermod -aG sudo instava
```

### Pointer le domaine vers le VPS

Chez ton registrar, crée un enregistrement **A** :

```
bot.tondomaine.fr  →  IP_DU_VPS
```

Vérifie depuis ta machine :

```bash
dig +short bot.tondomaine.fr
```

L'IP du VPS doit s'afficher. **Attends la propagation avant de démarrer Caddy** (sinon Let's Encrypt refusera le certificat).

---

## 3. Méthode recommandée : Docker Compose

L'image contient Node 22, Chromium et les polices nécessaires : rien d'autre à installer.

```bash
# En tant qu'utilisateur instava
su - instava
git clone https://github.com/IsholaRsk/INSTA_VA.git /opt/instava
cd /opt/instava

cp .env.example .env
nano .env
```

Renseigne au minimum :

```ini
INSTAVA_DOMAIN=bot.tondomaine.fr
INSTAVA_EMAIL=toi@tondomaine.fr
INSTAVA_TZ=Africa/Porto-Novo
```

Laisse `INSTAVA_SECRET_KEY` vide : le serveur génère une clé unique au premier démarrage, dans le volume de données.

```bash
docker compose up -d --build
docker compose logs -f bot
```

Au premier lancement tu vois :

```
Initialisation de la base instava.sqlite
Clé de chiffrement générée (data/secret.key). Sauvegardez-la avec la base.
Bot InstaVA 2.0.0 à l'écoute sur http://0.0.0.0:8080
```

Caddy demande un certificat automatiquement : au bout de quelques secondes, `https://bot.tondomaine.fr` répond.

```bash
docker compose ps          # bot et caddy doivent être "running"
curl -s https://bot.tondomaine.fr/api/health
```

**Sauvegarde** — la base et la clé vivent dans le volume `instava_data` :

```bash
docker compose exec bot node -e "
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync('/app/data/instava.sqlite');
  db.exec(\"VACUUM INTO '/app/data/sauvegarde.sqlite'\"); db.close();
"
docker compose cp bot:/app/data/sauvegarde.sqlite ./sauvegarde-$(date +%F).sqlite
docker compose cp bot:/app/data/secret.key ./secret-$(date +%F).key
```

Copie ces deux fichiers sur ton ordinateur. **Sans `secret.key`, les identifiants proxy enregistrés sont définitivement illisibles** (les cibles, elles, restent intactes).

Programme la sauvegarde chaque nuit :

```bash
crontab -e
```

```cron
15 3 * * * cd /opt/instava && docker compose exec -T bot node -e "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('/app/data/instava.sqlite');db.exec(\"VACUUM INTO '/app/data/auto.sqlite'\");db.close();" && docker compose cp bot:/app/data/auto.sqlite /home/instava/backups/instava-$(date +\%F).sqlite
```

---

## 4. Méthode sans Docker : Node + systemd + Caddy

Pour ceux qui préfèrent un service classique.

```bash
su - instava
git clone https://github.com/IsholaRsk/INSTA_VA.git /opt/instava
cd /opt/instava
npm ci --omit=dev
npx playwright install --with-deps chromium

sudo mkdir -p /var/lib/instava /etc/instava
sudo chown instava:instava /var/lib/instava
sudo chmod 700 /var/lib/instava
sudo cp deploy/instava.service /etc/systemd/system/instava.service
sudo cp .env.example /etc/instava/instava.env
sudo nano /etc/instava/instava.env
```

Dans `/etc/instava/instava.env`, adapte :

```ini
HOST=127.0.0.1
DATA_DIR=/var/lib/instava
INSTAVA_TZ=Africa/Porto-Novo
INSTAVA_SECURE_COOKIES=true
```

Puis :

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now instava
sudo systemctl status instava
sudo journalctl -u instava -f
```

### Caddy sur l'hôte

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install -y caddy
```

`/etc/caddy/Caddyfile` :

```caddy
bot.tondomaine.fr {
	encode zstd gzip
	reverse_proxy 127.0.0.1:8080 {
		header_up X-Forwarded-For {remote_host}
		header_up X-Forwarded-Proto {scheme}
	}
	header Strict-Transport-Security "max-age=31536000; includeSubDomains"
}
```

```bash
sudo systemctl reload caddy
```

---

## 5. Première connexion depuis le téléphone

1. Ouvre `https://bot.tondomaine.fr` dans le navigateur du téléphone.
2. Le serveur détecte le premier démarrage et affiche **Créer mon compte**. Choisis un e-mail et un mot de passe d'au moins 10 caractères. Ce compte est le **propriétaire** du serveur.
3. **Installe l'application** :
   - **iPhone / Safari** : bouton Partager → *Sur l'écran d'accueil*.
   - **Android / Chrome** : menu ⋮ → *Installer l'application* (ou *Ajouter à l'écran d'accueil*).
4. Crée ta première cible :
   - **Pseudo** : un nom court.
   - **URL** : la page à ouvrir.
   - **Libellé** : le texte exact du lien **ou du bouton** à cliquer. Laisse vide pour cliquer automatiquement l'élément principal.
   - **Mode Intervalle** : le nombre de clics et une **durée en jours** (1 à 365). Le bot en fera au moins 100 par jour.
   - **Mode Objectif** : un nombre exact, sans durée.
5. Coche la cible, puis **Lancer**. Le premier cycle part dans la minute.

> Si une confirmation est demandée (option *Confirmer les clics*, ou libellé sensible comme « Payer »), une carte **Confirmer & cliquer** apparaît dans l'activité. Un appui suffit, et le clic part depuis le VPS.

---

## 6. Utilisation au quotidien

| Écran | Ce qu'il montre |
|---|---|
| **Cibles enregistrées** | Chaque cible avec sa règle réelle (« 3 jour(s) · 300 clics au total · relevé depuis 50 pour tenir le minimum quotidien »). |
| **Clics du jour** | Le journal quotidien : clics réellement effectués par cible, avec les 14 derniers jours en barres. C'est ce compteur qui garantit les 100 clics/jour. |
| **Activité récente** | Chaque visite : réussi, en échec, en attente de confirmation, avec le libellé cliqué et l'URL finale. |
| **Webshare** | Champ unique pour les identifiants proxy, chiffrés AES-256-GCM sur le VPS, jamais renvoyés au navigateur. |

**Le bot tourne 24 h/24** : fermer l'application ou éteindre le téléphone ne l'arrête pas. Seul le bouton **Arrêter** (dans l'activité) annule les visites en attente.

### Mise à jour du bot

**Docker :**

```bash
cd /opt/instava && git pull && docker compose up -d --build
```

**systemd :**

```bash
cd /opt/instava && git pull && npm ci --omit=dev && sudo systemctl restart instava
```

La base est migrée automatiquement au démarrage ; fais quand même une sauvegarde avant.

---

## 7. Variante sans domaine : Tailscale

Aucun nom de domaine, aucun port ouvert sur Internet. L'application n'est joignable que depuis tes appareils, via un réseau privé chiffré.

1. Crée un compte gratuit sur [tailscale.com](https://tailscale.com) et installe Tailscale sur le VPS :

   ```bash
   curl -fsSL https://tailscale.com/install.sh | sh
   sudo tailscale up
   tailscale ip -4        # note l'adresse 100.x.y.z
   ```

2. Sur le téléphone, installe **Tailscale** depuis l'App Store / le Play Store et connecte-toi avec **le même compte**.

3. Démarre le bot sans Caddy :

   ```bash
   cd /opt/instava
   docker compose up -d bot      # uniquement le service bot
   ```

   Puis rends-le joignable sur le réseau Tailscale en publiant le port sur l'interface `tailscale0` :

   ```bash
   docker compose down
   ```

   Dans `docker-compose.yml`, remplace la section `expose` du service `bot` par :

   ```yaml
   ports:
     - "8080:8080"
   ```

   ```bash
   docker compose up -d bot
   ```

4. Depuis le téléphone, ouvre `http://100.x.y.z:8080`.

   ⚠️ En HTTP simple, le navigateur refuse les cookies `Secure`. Ajoute cette ligne au `.env` **uniquement dans ce cas** :

   ```ini
   INSTAVA_SECURE_COOKIES=false
   ```

   Puis `docker compose up -d bot`.

5. Pour un HTTPS local (recommandé), garde Caddy mais sans domaine public :

   ```caddy
   {
   	local_certs
   }
   https://100.x.y.z {
   	reverse_proxy bot:8080
   }
   ```

   Installe le certificat racine de Caddy (`/data/caddy/pki/authorities/local/root.crt`) sur le téléphone, puis ouvre `https://100.x.y.z`.

**Sécurité** : avec Tailscale, le bot n'est jamais exposé à Internet — c'est le mode le plus sûr, et il fonctionne même derrière un routeur sans IP fixe.

---

## 8. Sauvegardes et restauration

### Sauvegarde manuelle (systemd)

```bash
sudo -u instava DATA_DIR=/var/lib/instava BACKUP_DIR=/var/backups/instava ./deploy/backup.sh
```

Le script copie la base à chaud (`VACUUM INTO`, cohérent même pendant une écriture) et `secret.key`, puis supprime les archives de plus de 14 jours.

### Sauvegarde automatique

```bash
sudo mkdir -p /var/backups/instava && sudo chown instava:instava /var/backups/instava
sudo crontab -u instava -e
```

```cron
30 3 * * * DATA_DIR=/var/lib/instava BACKUP_DIR=/var/backups/instava /opt/instava/deploy/backup.sh >> /var/log/instava-backup.log 2>&1
```

### Restauration

```bash
sudo systemctl stop instava
sudo cp /var/backups/instava/2026-11-09T033000Z.sqlite /var/lib/instava/instava.sqlite
sudo cp /var/backups/instava/2026-11-09T033000Z.secret.key /var/lib/instava/secret.key
sudo chown instava:instava /var/lib/instava/*
sudo systemctl start instava
```

En Docker : arrête la pile, restaure dans le volume avec `docker compose cp`, redémarre.

---

## 8 bis. Sites protégés par Cloudflare

Beaucoup de sites à clics sont derrière Cloudflare. Un navigateur automatisé y reçoit une page **« Just a moment… »** au lieu du site. Trois niveaux de réponse sont déjà en place :

1. **Empreinte cohérente** — l'User-Agent annonce la version réelle du moteur (et non une version périmée, écart qui suffit à déclencher un challenge), les *client hints* concordent, l'empreinte de bureau est réaliste (1366×768, fr-FR, fuseau de Cotonou), et `navigator.webdriver` est neutralisé avant le premier script de la page.
2. **Attente du challenge** — le bot laisse jusqu'à `INSTAVA_CHALLENGE_WAIT_MS` (15 s) à la vérification pour se résoudre seule, comme le ferait un visiteur. Beaucoup de challenges « managed » passent sans intervention.
3. **Repli par proxy** — si le blocage persiste alors que la connexion était directe et qu'un proxy est configuré, le cycle est **rejoué une fois via le proxy**, qui présente une autre adresse IP.

### Si le blocage persiste

La cause dominante n'est alors plus le navigateur mais **la réputation de l'IP**. Une IP de datacenter (OVH, Hetzner, Scaleway…) est massivement utilisée par des robots : Cloudflare la traite en conséquence. Dans ce cas :

- **Configure un proxy résidentiel** dans l'onglet *Webshare* de l'application. C'est la solution qui marche réellement pour ce type de site.
- Évite les proxys de datacenter dans la mesure du possible : ils sont aussi mal notés que l'IP du VPS.
- Un challenge peut rester **insoluble** si le site exige un CAPTCHA interactif : aucun robot ne peut passer une case à cocher cliquée par un humain. Le bot s'arrête alors proprement et l'indique, sans consommer le quota.

Le journal affiche dans ce cas :

```
✗ Boutique — Le site affiche une page de vérification Cloudflare (HTTP 403)
  au lieu de la page réelle : il bloque le navigateur du VPS.
  Essaie avec un proxy résidentiel Webshare, ou depuis une IP moins exposée.
```

Ce cycle **n'est pas compté** dans les clics du jour, puisque le site n'a jamais été atteint.

> ⚠️ Le contournement d'une protection anti-bot peut violer les conditions d'utilisation du site visé. Ce réglage sert à rendre le bot présentable (empreinte cohérente, comportement humain), pas à casser une protection. À toi de vérifier que l'usage prévu est autorisé.

## 9. Dépannage

| Symptôme | Cause probable | Solution |
|---|---|---|
| `502 Bad Gateway` | Le conteneur `bot` ne démarre pas | `docker compose logs bot` |
| Caddy ne délivre pas le certificat | DNS pas propagé, ou port 80 fermé | `dig +short tondomaine.fr` ; `ufw status` |
| `Executable doesn't exist` | Chromium absent | Docker : reconstruire l'image. systemd : `npx playwright install --with-deps chromium` |
| « Aucun lien ou bouton visible ne correspond » | Libellé différent sur la page | Utilise le texte affiché exact ; vide le champ pour laisser le bot choisir |
| « Plusieurs éléments correspondent » | Libellé ambigu | Précise le texte (accents, casse ignorés, mais le libellé doit être unique) |
| Les cycles ne partent plus | Écart de 5 minutes non écoulé, ou quota du jour atteint | Vérifie **Clics du jour** : 288 max par jour et par cible |
| « Page de vérification Cloudflare » | IP de datacenter mal notée, ou navigateur détecté | Chapitre **8 bis** : configure un proxy résidentiel Webshare |
| Session expirée sans cesse | Cookie `Secure` en HTTP | `INSTAVA_SECURE_COOKIES=false` (uniquement en réseau privé HTTP) |
| Page blanche après mise à jour | Service worker en cache | Recharge en forçant (Safari : appui long sur ⟳), ou réinstalle la PWA |

**Voir ce que fait le bot en direct :**

```bash
docker compose logs -f bot          # ou : sudo journalctl -u instava -f
```

Chaque cycle affiche une ligne du type :

```
✓ Boutique — bouton « Découvrir la collection » → https://exemple.fr/merci
✗ Boutique — Aucun lien ou bouton visible ne correspond exactement à « Acheter ».
```

---

## 10. Sécurité : ce qui est en place

- **Mots de passe** : scrypt (N=16384, r=8, p=1), sel aléatoire par compte, comparaison à temps constant.
- **Sessions** : jeton opaque de 32 octets, seul son SHA-256 est stocké. Cookie `HttpOnly`, `SameSite=Strict`, `Secure` derrière HTTPS. Expiration en base, purge automatique.
- **Identifiants proxy** : AES-256-GCM avec clé dérivée (scrypt), fichier `secret.key` en `0600`. Jamais renvoyés au navigateur, jamais journalisés.
- **Anti-force brute** : 10 tentatives de connexion par quart d'heure et par IP, 5 inscriptions par heure.
- **Réseau** : le conteneur n'expose pas son port ; seul Caddy y accède. HSTS, CSP stricte, `X-Frame-Options: DENY`, `nosniff`.
- **Piège SSRF bloqué** : chaque URL (navigation *et* chaque sous-ressource, y compris après le clic) est vérifiée ; les adresses privées, locales et les résolutions DNS internes sont refusées.
- **Isolation du navigateur** : contexte Playwright recréé à chaque cycle, fermé systématiquement, même en cas d'erreur.

**Ce que tu dois faire de ton côté :**

1. Garde le système à jour : `apt upgrade` régulièrement, et `docker compose pull` pour Caddy.
2. Utilise un mot de passe long et unique (idéalement généré).
3. Si tu ouvres les inscriptions, définis `INSTAVA_SIGNUP_CODE` pour éviter que n'importe qui crée un compte.
4. Sauvegarde `instava.sqlite` **et** `secret.key` : l'un sans l'autre ne suffit pas.
5. Ne partage jamais le fichier `.env` ni `secret.key`.

---

## 11. Ce qui a changé par rapport à la version Vercel + Supabase

| Avant | Maintenant |
|---|---|
| `api/` serverless sur Vercel | Serveur Node unique sur le VPS (`server/`) |
| Supabase (auth, base, Vault) | SQLite local + scrypt + AES-256-GCM |
| Cron Vercel toutes les 5 min | Boucle interne toutes les 5 s |
| Durée en semaines, tirage ±10 | Durée en **jours**, total exact, minimum **100 clics/jour** |
| Clic sur lien uniquement | Clic sur **lien ou bouton** |
| 300 visites max par lancement | Jusqu'à 1 000 000, plafonné par la physique (288/jour/cible) |

Les dossiers `api/`, `lib/`, `supabase/` et `vercel.json` de l'ancienne version sont conservés à titre de référence mais **ne sont plus utilisés** : tu peux les supprimer.
