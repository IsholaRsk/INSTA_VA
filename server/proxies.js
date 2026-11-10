import '../extension/bot-utils.js';
import { decryptSecret, encryptSecret, maskValue } from './crypto.js';
import { validateProxyConfiguration } from './net-safety.js';
import { HttpError } from './errors.js';

// Parsing, déduplication et rotation viennent de l'extension : mêmes règles
// des deux côtés (formats acceptés, ordre d'import, tirage aléatoire).
const utils = globalThis.InstaVAUtils;

export const MAX_PROXY_LINES_PER_IMPORT = 5000;

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
 * Passe par un tunnel CONNECT natif (`node:http`) puis une requête TLS directe :
 * aucune dépendance supplémentaire, et l'appel échoue proprement (401/407/refus)
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

export async function probeProxy(entry, timeoutMs = 8000) {
  const http = await import('node:http');
  const https = await import('node:https');
  const net = await import('node:net');
  const tls = await import('node:tls');

  const target = { host: 'api.ipify.org', port: 443, path: '/?format=json' };
  const auth = 'Basic ' + Buffer.from(`${entry.username}:${entry.password}`).toString('base64');

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const timer = setTimeout(() => finish(reject, new Error('Délai dépassé : le proxy ne répond pas.')), timeoutMs);

    const connectRequest = http.request({
      host: entry.host,
      port: entry.port,
      method: 'CONNECT',
      path: `${target.host}:${target.port}`,
      headers: { host: `${target.host}:${target.port}`, 'proxy-authorization': auth },
      timeout: timeoutMs,
    });

    connectRequest.on('connect', (response, socket) => {
      if (response.statusCode !== 200) {
        socket.destroy();
        const detail = response.statusCode === 407
          ? 'Identifiants refusés par le proxy (407).'
          : `Le proxy a refusé le tunnel (HTTP ${response.statusCode}).`;
        finish(reject, new Error(detail));
        return;
      }
      // Tunnel établi : on négocie TLS à travers, comme un vrai navigateur.
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
            if (res.statusCode !== 200) return finish(reject, new Error(`Réponse ${res.statusCode} du service de test.`));
            try {
              const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
              if (!data?.ip) return finish(reject, new Error('IP de sortie illisible.'));
              finish(resolve, { ip: data.ip });
            } catch { finish(reject, new Error('Réponse illisible du service de test.')); }
          });
        });
        request.on('error', (error) => { secure.destroy(); finish(reject, new Error(friendlyProxyError(error))); });
        request.end();
      });
      secure.on('error', (error) => finish(reject, new Error(friendlyProxyError(error))));
    });

    connectRequest.on('error', (error) => {
      finish(reject, new Error(friendlyProxyError(error)));
    });
    connectRequest.on('timeout', () => { connectRequest.destroy(); finish(reject, new Error('Le proxy ne répond pas (délai dépassé).')); });
    connectRequest.end();
  });
}
