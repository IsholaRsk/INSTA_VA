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
  const all = store.listProxies(userId).filter((proxy) => proxy.enabled);
  if (!all.length) return null;

  // Règle 1 : Cloudflare juge d'abord le réseau de l'IP. Un proxy résidentiel
  // passé le test a donc la priorité sur toute la liste d'hébergeurs. Si aucun
  // n'a été identifié comme résidentiel, on garde la liste complète : mieux
  // vaut tenter une IP datacenter que ne rien faire du tout.
  const known = all.filter((proxy) => proxy.ip_kind);
  const residential = known.filter((proxy) => proxy.ip_kind === 'residential');
  const untested = all.filter((proxy) => !proxy.ip_kind);
  let candidates = all;
  if (residential.length) {
    // Les IP non testées restent éligibles : elles peuvent être résidentielles.
    candidates = [...residential, ...untested];
  }

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
/**
 * Classification d'une IP de sortie : hébergement (datacenter) ou accès
 * grand public. C'est le critère qui décide, avant tout le reste, du sort
 * d'une requête devant Cloudflare — et c'est celui que l'utilisateur ne voit
 * nulle part aujourd'hui.
 *
 * La classification s'appuie sur l'ASN (le réseau propriétaire de l'adresse),
 * pas sur le nom de domaine : `proxy1.webshare.io` ne dit rien, `AS16276 OVH`
 * dit tout. Deux services interrogés en cascade, réponse mise en cache.
 */
// ASN des hébergeurs et fournisseurs de cloud qui vendent massivement du proxy
// « datacenter » : Webshare, Oxylabs, Smartproxy, IPRoyal… y logent leurs IP.
const DATACENTER_ASNS = new Map([
  [16276, 'OVH'], [12876, 'Scaleway'], [51167, 'Contabo'], [24940, 'Hetzner'],
  [197540, 'Netcup'], [8560, 'IONOS'], [20773, 'Host Europe'], [34011, 'Host Europe'],
  [16509, 'Amazon AWS'], [14618, 'Amazon AWS'], [15169, 'Google'], [396982, 'Google Cloud'],
  [8075, 'Microsoft Azure'], [8068, 'Microsoft'], [14061, 'DigitalOcean'],
  [63949, 'Linode / Akamai'], [20473, 'Vultr / Choopa'], [26347, 'DreamHost'],
  [46606, 'Unified Layer'], [26496, 'GoDaddy'], [32244, 'Liquid Web'],
  [9009, 'M247'], [51852, 'Private Layer'], [62240, 'Clouvider'],
  [41378, 'Kirino'], [199524, 'G-Core Labs'], [13335, 'Cloudflare'],
  [9002, 'RETN'], [202425, 'IP Volume'], [209854, 'Zenlayer'], [45090, 'Tencent'],
  [55990, 'Huawei Cloud'], [37963, 'Alibaba Cloud'], [45102, 'Alibaba Cloud'],
  [47890, 'Unmanaged Ltd'], [200373, 'Ipxo'], [208091, 'Hostinger'],
  [47583, 'Hostinger'], [34241, 'Patchstack'], [60117, 'VSHosting'],
]);

const ASN_SERVICES = [
  {
    name: 'ipinfo',
    request: (ip) => ({ url: `https://ipinfo.io/${encodeURIComponent(ip)}/json` }),
    read: (data) => {
      const org = String(data?.org || '');
      const match = /^AS(\d+)\s+(.*)$/i.exec(org.trim());
      if (match) return { asn: Number(match[1]), org: match[2] };
      // Réponse sans AS : on garde au moins l'organisation pour l'affichage.
      return org ? { asn: null, org } : null;
    },
  },
  {
    name: 'ipwho',
    request: (ip) => ({ url: `https://ipwho.is/${encodeURIComponent(ip)}` }),
    read: (data) => {
      if (!data || data.success === false) return null;
      const asn = Number(data?.connection?.asn);
      const org = String(data?.connection?.org || data?.connection?.isp || '').trim();
      if (!Number.isInteger(asn) && !org) return null;
      return { asn: Number.isInteger(asn) ? asn : null, org };
    },
  },
];

const asnCache = new Map();
const ASN_CACHE_MS = 6 * 60 * 60 * 1000;

/** Vide le cache ASN (utile aux tests, ou après un changement de fournisseur). */
export function clearAsnCache() {
  asnCache.clear();
}

/** Classe une IP à partir de son numéro d'ASN et du nom de l'organisation. */
export function classifyIp({ asn = null, org = '' } = {}) {
  const normalizedOrg = String(org || '').trim();
  const number = Number.isInteger(asn) ? asn : null;
  if (number && DATACENTER_ASNS.has(number)) {
    return { kind: 'datacenter', asn: number, org: normalizedOrg || DATACENTER_ASNS.get(number), provider: DATACENTER_ASNS.get(number) };
  }
  // Filet de sécurité : certains services ne donnent que le nom de l'hébergeur.
  const hostingPattern = /(ovh|hetzner|scaleway|contabo|digitalocean|amazon|aws|google cloud|microsoft|azure|linode|akamai|vultr|hostinger|m247|cloudflare|alibaba|tencent|oracle|leaseweb|netcup|ionos)/i;
  if (hostingPattern.test(normalizedOrg)) {
    return { kind: 'datacenter', asn: number, org: normalizedOrg, provider: normalizedOrg };
  }
  return { kind: 'residential', asn: number, org: normalizedOrg, provider: null };
}

/** Interroge les services d'ASN avec repli et cache. Retourne null si aucun ne répond. */
export async function lookupAsn(ip, { timeoutMs = 4000, fetchImpl = globalThis.fetch } = {}) {
  const address = String(ip || '').trim();
  if (!address) return null;

  const cached = asnCache.get(address);
  if (cached && cached.until > Date.now()) return cached.value;

  for (const service of ASN_SERVICES) {
    try {
      const { url } = service.request(address);
      const response = await fetchImpl(url, {
        signal: AbortSignal.timeout(timeoutMs),
        headers: { accept: 'application/json', 'user-agent': 'instava-bot/2' },
      });
      if (!response.ok) continue;
      const info = service.read(await response.json());
      if (!info) continue;
      const value = { ...info, service: service.name };
      asnCache.set(address, { value, until: Date.now() + ASN_CACHE_MS });
      if (asnCache.size > 500) asnCache.clear();
      return value;
    } catch { /* service injoignable : on tente le suivant */ }
  }
  return null;
}

/**
 * Enrichit une IP de sortie avec sa nature réseau. Ne lève jamais : le test
 * d'un proxy doit rester utile même si l'annuaire ASN est injoignable.
 */
export async function describeExitIp(ip, options) {
  const info = await lookupAsn(ip, options);
  if (!info) return { ip, kind: 'unknown', asn: null, org: '', provider: null };
  return { ip, ...classifyIp(info) };
}

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
