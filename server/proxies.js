import { connect as netConnect } from 'node:net';
import '../extension/bot-utils.js';
import { decryptSecret, encryptSecret, maskValue } from './crypto.js';
import { validateProxyConfiguration } from './net-safety.js';
import { HttpError } from './errors.js';

// Parsing, déduplication et rotation viennent de l'extension : mêmes règles
// des deux côtés (formats acceptés, ordre d'import, tirage aléatoire).
const utils = globalThis.InstaVAUtils;

export const MAX_PROXY_LINES_PER_IMPORT = 5000;

// 5000 lignes de ~180 caractères dépassent largement les 64 Ko du corps JSON
// par défaut : l'import de fichier a droit à son propre budget.
export const MAX_PROXY_IMPORT_BYTES = 2 * 1024 * 1024;
export const MAX_PROXY_IMPORT_CHARS = Math.floor(MAX_PROXY_IMPORT_BYTES / 4);

/**
 * Analyse un texte collé (un proxy par ligne) et renvoie les entrées valides
 * et les lignes rejetées, avec un compte rendu lisible.
 */
export function parseProxyImport(text, { defaultUsername = '', defaultPassword = '', defaultScheme = 'http' } = {}) {
  const result = utils.parseProxyLines(text, { defaultUsername, defaultPassword, defaultScheme });
  return {
    entries: result.entries || [],
    errors: result.errors || [],
    // Doublons internes au texte collé + rejets (lignes mal formées).
    duplicates: Number(result.duplicates || 0),
  };
}

/** Vérifie qu'un proxy pointe vers un hôte public et porte des identifiants. */
export async function validateProxyEntry(entry) {
  return validateProxyConfiguration({
    scheme: entry.scheme,
    host: entry.host,
    port: entry.port,
    username: entry.username,
    password: entry.password,
  });
}

/** Prépare une ligne de base de données à partir d'une entrée validée. */
export function proxyRow(entry, secretKey, id, label = '') {
  const secret = JSON.stringify({ username: entry.username, password: entry.password });
  return {
    id,
    label: String(label || '').slice(0, 80),
    scheme: entry.scheme,
    host: entry.host,
    port: entry.port,
    username_masked: maskValue(entry.username),
    secret_box: encryptSecret(secret, secretKey),
  };
}

/** Reconstruit les identifiants en clair pour Playwright (jamais renvoyés au client). */
export function decryptProxyRow(row, secretKey) {
  if (!row) return null;
  const parsed = JSON.parse(decryptSecret(row.secret_box, secretKey));
  return {
    id: row.id,
    scheme: row.scheme,
    host: row.host,
    port: Number(row.port),
    username: parsed.username,
    password: parsed.password,
  };
}

/**
 * Choisit le proxy du prochain cycle selon l'état enregistré, puis avance le
 * curseur. Retourne `null` si la rotation est désactivée ou sans proxy actif.
 */
export function nextProxy(store, userId, { random = Math.random } = {}) {
  const state = store.getProxyState(userId);
  if (!state.enabled) return null;
  const candidates = store.listProxies(userId).filter((proxy) => proxy.enabled);
  if (!candidates.length) return null;

  // En mode aléatoire, on écarte le proxy du cycle précédent : deux visites de
  // suite depuis la même IP, c'est exactement ce que la rotation doit éviter.
  let pool = candidates;
  if (state.rotation === 'random' && candidates.length > 1 && state.lastProxyId) {
    pool = candidates.filter((proxy) => proxy.id !== state.lastProxyId);
  }

  const picked = utils.pickProxy(pool, { mode: state.rotation, cursor: state.cursor }, random);
  if (!picked?.proxy) return null;

  store.saveProxyState(userId, { cursor: picked.cursor, lastProxyId: picked.proxy.id });
  const row = store.getProxyRow(userId, picked.proxy.id);
  return { proxy: decryptProxyRow(row, store.secretKey || ''), id: picked.proxy.id };
}

/**
 * Le magasin ne connaît pas la clé de chiffrement : on la lui attache au
 * démarrage pour que `nextProxy` reste utilisable sans la faire circuler.
 */
export function attachSecretKey(store, secretKey) {
  Object.defineProperty(store, 'secretKey', { value: secretKey, enumerable: false, configurable: true });
  return store;
}

export function assertProxyLimit(count) {
  if (count > MAX_PROXY_LINES_PER_IMPORT) {
    throw new HttpError(400, `Import limité à ${MAX_PROXY_LINES_PER_IMPORT} proxys par lot.`);
  }
}

/**
 * Teste un proxy en récupérant l'IP de sortie observée.
 *
 * HTTP/HTTPS : tunnel `CONNECT` natif puis TLS direct.
 * SOCKS5 : vraie poignée de main (RFC 1928) — le protocole n'a rien à voir avec
 * HTTP, envoyer un `CONNECT` à un serveur SOCKS5 le fait échouer à coup sûr.
 *
 * Aucune dépendance supplémentaire, et l'appel échoue proprement (407, refus)
 * si le proxy ou les identifiants ne fonctionnent pas.
 */
// Les erreurs système remontent en anglais (`read ECONNRESET`) : on les traduit pour l'interface.
export function friendlyProxyError(error) {
  // `error.message` d'abord : `String(new Error(''))` vaut « Error ».
  const message = String((error && typeof error === 'object' && 'message' in error ? error.message : error) || '').trim();
  if (/ECONNREFUSED/i.test(message)) return 'Connexion au proxy impossible (refusée).';
  if (/ENOTFOUND|EAI_AGAIN/i.test(message)) return 'Hôte du proxy introuvable.';
  if (/ETIMEDOUT|timed? ?out|délai/i.test(message)) return 'Le proxy ne répond pas (délai dépassé).';
  if (/ECONNRESET|EPIPE|socket hang up/i.test(message)) return 'Le proxy a coupé la connexion.';
  if (/EHOSTUNREACH|ENETUNREACH/i.test(message)) return 'Le proxy est injoignable depuis le VPS.';
  if (/certificate|SSL|TLS/i.test(message)) return 'Le tunnel chiffré vers le proxy a échoué.';
  if (/407/.test(message)) return 'Identifiants refusés par le proxy (407).';
  return message.slice(0, 140) || 'Le proxy n’a pas répondu.';
}

// Deux services d'écho d'IP : si le premier est bloqué par le réseau du VPS ou
// tombe, le second prend le relais. Un échec des deux reste un échec du proxy.
const PROBE_TARGETS = [
  { host: 'api.ipify.org', port: 443, path: '/?format=json', pick: (data) => data?.ip },
  { host: 'ipinfo.io', port: 443, path: '/json', pick: (data) => data?.ip },
];

/** Requête HTTPS à travers un flux déjà tunnelisé, pour lire l'IP de sortie. */
async function readExitIpFrom(socket, target, timeoutMs) {
  const https = await import('node:https');
  const tls = await import('node:tls');
  return new Promise((resolve, reject) => {
    const secure = tls.connect({ socket, servername: target.host, rejectUnauthorized: false }, () => {
      const request = https.request({
        host: target.host, path: target.path, method: 'GET', socket: secure,
        servername: target.host,
        headers: { host: target.host, accept: 'application/json', connection: 'close' },
      }, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          secure.destroy();
          if (res.statusCode !== 200) return reject(new Error(`Réponse ${res.statusCode} du service de test.`));
          try {
            const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            const ip = target.pick(data);
            if (!ip) return reject(new Error('IP de sortie illisible.'));
            resolve({ ip });
          } catch { reject(new Error('Réponse illisible du service de test.')); }
        });
      });
      request.on('error', (error) => { secure.destroy(); reject(new Error(friendlyProxyError(error))); });
      request.end();
    });
    secure.setTimeout(timeoutMs, () => { secure.destroy(); reject(new Error('Le proxy ne répond pas (délai dépassé).')); });
    secure.on('error', (error) => reject(new Error(friendlyProxyError(error))));
  });
}

/**
 * Lit l'IP de sortie sur l'un des services d'écho. Un flux tunnelisé ne peut
 * servir qu'une fois : on redemande un tunnel neuf pour chaque tentative.
 */
async function readExitIpWithFallback(openTunnel, timeoutMs) {
  let lastError = null;
  for (const target of PROBE_TARGETS) {
    let socket = null;
    try {
      socket = await openTunnel(target);
      return await readExitIpFrom(socket, target, timeoutMs);
    } catch (error) {
      lastError = error;
    } finally {
      if (socket) socket.destroy();
    }
  }
  throw lastError || new Error('Le proxy n’a pas répondu.');
}

/** Poignée de main SOCKS5 (RFC 1928) avec authentification par mot de passe. */
function openSocks5Tunnel(entry, target, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = netConnect({ host: entry.host, port: entry.port });
    let stage = 'greeting';
    let buffer = Buffer.alloc(0);

    const fail = (message) => { socket.destroy(); reject(new Error(message)); };
    socket.setTimeout(timeoutMs, () => fail('Le proxy ne répond pas (délai dépassé).'));
    socket.on('error', (error) => reject(new Error(friendlyProxyError(error))));

    // Le serveur peut répondre en plusieurs paquets : on accumule et on découpe.
    const consume = (bytes) => { buffer = Buffer.concat([buffer, bytes]); };

    const step = () => {
      if (stage === 'greeting') {
        if (buffer.length < 2) return;
        if (buffer[0] !== 0x05) return fail('Ce n’est pas un serveur SOCKS5 (version inattendue).');
        const method = buffer[1];
        buffer = buffer.subarray(2);
        if (method === 0x02) {
          // Nom d'utilisateur / mot de passe (RFC 1929).
          const user = Buffer.from(String(entry.username || ''), 'utf8');
          const pass = Buffer.from(String(entry.password || ''), 'utf8');
          const packet = Buffer.concat([
            Buffer.from([0x01, user.length]), user,
            Buffer.from([pass.length]), pass,
          ]);
          stage = 'auth';
          socket.write(packet);
        } else if (method === 0x00) {
          stage = 'connect';
          sendConnect();
        } else if (method === 0xff) {
          return fail('Identifiants refusés par le proxy SOCKS5 (aucune méthode acceptée).');
        } else {
          return fail(`Le proxy SOCKS5 exige une méthode d’authentification non gérée (0x${method.toString(16)}).`);
        }
        return step();
      }

      if (stage === 'auth') {
        if (buffer.length < 2) return;
        const status = buffer[1];
        buffer = buffer.subarray(2);
        if (status !== 0x00) return fail('Identifiants refusés par le proxy SOCKS5.');
        stage = 'connect';
        sendConnect();
        return step();
      }

      if (stage === 'connect') {
        if (buffer.length < 5) return;
        if (buffer[0] !== 0x05) return fail('Réponse SOCKS5 invalide.');
        const reply = buffer[1];
        if (reply !== 0x00) {
          const reasons = {
            0x01: 'erreur générale du proxy SOCKS5.',
            0x02: 'connexion non autorisée par le proxy SOCKS5.',
            0x03: 'réseau injoignable depuis le proxy SOCKS5.',
            0x04: 'hôte injoignable depuis le proxy SOCKS5.',
            0x05: 'connexion refusée par le destinataire.',
            0x06: 'TTL expiré.',
            0x07: 'commande non supportée par le proxy SOCKS5.',
            0x08: 'type d’adresse non supporté par le proxy SOCKS5.',
          };
          return fail(`Le proxy SOCKS5 a refusé la connexion : ${reasons[reply] || `code ${reply}`}`);
        }
        // Adresse de liaison à ignorer, de longueur variable.
        const addressType = buffer[3];
        const addressLength = addressType === 0x01 ? 4 : addressType === 0x04 ? 16 : buffer[4] + 1;
        const total = 4 + addressLength + 2;
        if (buffer.length < total) return;
        buffer = buffer.subarray(total);
        socket.removeAllListeners('data');
        socket.setTimeout(0);
        resolve(socket);
        return;
      }
    };

    function sendConnect() {
      const host = Buffer.from(target.host, 'utf8');
      socket.write(Buffer.concat([
        Buffer.from([0x05, 0x01, 0x00, 0x03, host.length]), host,
        Buffer.from([(target.port >> 8) & 0xff, target.port & 0xff]),
      ]));
    }

    socket.on('data', (bytes) => {
      consume(bytes);
      try { step(); } catch (error) { fail(error.message); }
    });
    socket.on('connect', () => {
      // Aucune authentification préférée, mais on accepte aussi identifiant/mot de passe.
      const methods = entry.username ? [0x00, 0x02] : [0x00];
      socket.write(Buffer.from([0x05, methods.length, ...methods]));
    });
  });
}

export async function probeProxy(entry, timeoutMs = 8000) {
  const scheme = String(entry?.scheme || 'http').toLowerCase();
  if (scheme === 'socks5' || scheme === 'socks') {
    return readExitIpWithFallback(
      (target) => openSocks5Tunnel(entry, target, timeoutMs),
      timeoutMs,
    );
  }

  const http = await import('node:http');
  const auth = 'Basic ' + Buffer.from(`${entry.username}:${entry.password}`).toString('base64');

  // Tunnel HTTP CONNECT vers la cible demandée (une par tentative de repli).
  const openTunnel = (target) => new Promise((resolve, reject) => {
    const request = http.request({
      host: entry.host,
      port: entry.port,
      method: 'CONNECT',
      path: `${target.host}:${target.port}`,
      headers: { host: `${target.host}:${target.port}`, 'proxy-authorization': auth },
      timeout: timeoutMs,
    });
    request.on('connect', (response, socket) => {
      if (response.statusCode !== 200) {
        socket.destroy();
        const detail = response.statusCode === 407
          ? 'Identifiants refusés par le proxy (407).'
          : `Le proxy a refusé le tunnel (HTTP ${response.statusCode}).`;
        reject(new Error(detail));
        return;
      }
      resolve(socket);
    });
    request.on('error', (error) => reject(new Error(friendlyProxyError(error))));
    request.on('timeout', () => { request.destroy(); reject(new Error('Le proxy ne répond pas (délai dépassé).')); });
    request.end();
  });

  return readExitIpWithFallback(openTunnel, timeoutMs);
}
