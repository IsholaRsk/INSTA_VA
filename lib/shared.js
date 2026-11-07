import { randomInt } from 'node:crypto';
import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const dnsCache = new Map();

export class HttpError extends Error {
  constructor(status, message, code = 'request_error') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.end(JSON.stringify(payload));
}

export function requireMethod(req, method) {
  if (req.method !== method) throw new HttpError(405, 'Méthode non autorisée.', 'method_not_allowed');
}

export async function readJson(req, maxBytes = 32768) {
  if (Buffer.isBuffer(req.body)) {
    if (req.body.length > maxBytes) throw new HttpError(413, 'Requête trop volumineuse.');
    try { return JSON.parse(req.body.toString('utf8')); } catch { throw new HttpError(400, 'Corps JSON invalide.'); }
  }
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') {
    if (Buffer.byteLength(req.body) > maxBytes) throw new HttpError(413, 'Requête trop volumineuse.');
    try { return JSON.parse(req.body); } catch { throw new HttpError(400, 'Corps JSON invalide.'); }
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > maxBytes) throw new HttpError(413, 'Requête trop volumineuse.');
    chunks.push(chunk);
  }
  if (!bytes) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new HttpError(400, 'Corps JSON invalide.'); }
}

function assertServerConfig({ requireAnon = false } = {}) {
  let parsedUrl;
  try { parsedUrl = new URL(SUPABASE_URL); } catch {}
  if (!parsedUrl || parsedUrl.protocol !== 'https:' || parsedUrl.username || parsedUrl.password ||
      !SUPABASE_SERVICE_ROLE_KEY || (requireAnon && !SUPABASE_ANON_KEY)) {
    throw new HttpError(503, 'Le service cloud n’est pas encore configuré correctement.', 'server_not_configured');
  }
}

async function supabaseRequest(path, options = {}) {
  assertServerConfig();
  const headers = new Headers(options.headers || {});
  headers.set('apikey', SUPABASE_SERVICE_ROLE_KEY);
  // Legacy service-role JWTs are accepted as the PostgREST bearer token. New sb_secret_ keys
  // are authenticated by the API gateway from the apikey header and are not JWTs.
  if (SUPABASE_SERVICE_ROLE_KEY.startsWith('sb_secret_')) headers.delete('Authorization');
  else headers.set('Authorization', `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`);
  if (options.body !== undefined && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  const response = await fetch(`${SUPABASE_URL}${path}`, {
    ...options,
    headers,
    signal: options.signal || AbortSignal.timeout(25000),
  });
  const text = await response.text();
  let result = null;
  if (text) {
    try { result = JSON.parse(text); } catch { result = text; }
  }
  if (!response.ok) {
    if (result?.code === '23505') {
      throw new HttpError(409, 'Une session est déjà en cours ou un cycle a déjà été créé.', 'conflict');
    }
    const message = result && typeof result === 'object'
      ? (result.message || result.msg || result.error_description || result.error || 'Erreur du service cloud.')
      : 'Erreur du service cloud.';
    throw new HttpError(502, String(message).slice(0, 240), 'database_error');
  }
  return result;
}

export async function supabaseTable(table, params = {}, options = {}) {
  const search = new URLSearchParams(params);
  const suffix = search.size ? `?${search.toString()}` : '';
  return supabaseRequest(`/rest/v1/${table}${suffix}`, options);
}

export async function supabaseRpc(name, payload = {}) {
  return supabaseRequest(`/rest/v1/rpc/${name}`, { method: 'POST', body: JSON.stringify(payload) });
}

export async function authenticateUser(req) {
  assertServerConfig({ requireAnon: true });
  const authorization = req.headers.authorization || '';
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  if (!match) throw new HttpError(401, 'Connectez-vous pour continuer.', 'not_authenticated');
  const response = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${match[1]}` },
    signal: AbortSignal.timeout(12000),
  });
  if (!response.ok) throw new HttpError(401, 'Votre session a expiré. Reconnectez-vous.', 'session_expired');
  const user = await response.json();
  if (!user?.id) throw new HttpError(401, 'Session invalide.', 'invalid_session');
  return { id: user.id, email: user.email || '' };
}

export function getPublicConfig() {
  assertServerConfig({ requireAnon: true });
  return { supabaseUrl: SUPABASE_URL, supabaseAnonKey: SUPABASE_ANON_KEY };
}

function isPrivateIpv4(address) {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = parts;
  return a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && (parts[2] === 0 || parts[2] === 2)) || (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && parts[2] === 100))) ||
    (a === 203 && b === 0 && parts[2] === 113);
}

function isPrivateIp(address) {
  const version = isIP(address);
  if (version === 4) return isPrivateIpv4(address);
  if (version !== 6) return true;
  const lower = address.toLowerCase().split('%')[0];
  if (lower.startsWith('::ffff:')) {
    const mapped = lower.slice('::ffff:'.length);
    if (isIP(mapped) === 4) return isPrivateIpv4(mapped);
    return true;
  }
  // Only global-unicast IPv6 (2000::/3) is allowed.
  return !(lower.startsWith('2') || lower.startsWith('3')) ||
    lower.startsWith('2001:db8:') || lower === '2001:db8::';
}

function isBlockedHostname(hostname) {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  return host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') ||
    host.endsWith('.internal') || host.endsWith('.home.arpa') || host.endsWith('.test') ||
    host.endsWith('.invalid') || host.endsWith('.example');
}

export function normalizeTargetUrl(input) {
  let raw = String(input ?? '').trim();
  if (!raw) throw new HttpError(400, 'Saisissez une URL.');
  if (!/^[a-z][a-z\d+.-]*:\/\//i.test(raw)) raw = `https://${raw}`;
  let parsed;
  try { parsed = new URL(raw); } catch { throw new HttpError(400, 'URL invalide.'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || !parsed.hostname) {
    throw new HttpError(400, 'Utilisez une URL HTTP ou HTTPS publique, sans identifiants intégrés.');
  }
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
  if (isBlockedHostname(hostname) || (isIP(hostname) && isPrivateIp(hostname))) {
    throw new HttpError(400, 'Les adresses locales ou privées ne sont pas autorisées.');
  }
  parsed.hash = '';
  if (parsed.href.length > 2048) throw new HttpError(400, 'URL trop longue (maximum 2048 caractères).');
  return parsed.href;
}

export async function assertPublicRequestUrl(input) {
  let parsed;
  try { parsed = new URL(input); } catch { throw new Error('URL de requête invalide'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password) {
    throw new Error('Type d’URL non autorisé');
  }
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (isBlockedHostname(hostname)) throw new Error('Hôte local bloqué');
  if (isIP(hostname)) {
    if (isPrivateIp(hostname)) throw new Error('Adresse IP privée bloquée');
    return;
  }
  const cached = dnsCache.get(hostname);
  if (cached && cached.until > Date.now()) {
    if (!cached.safe) throw new Error('Hôte DNS privé ou non résolu');
    return;
  }
  let addresses;
  try { addresses = await lookup(hostname, { all: true, verbatim: true }); }
  catch { addresses = []; }
  const safe = addresses.length > 0 && addresses.every((item) => !isPrivateIp(item.address));
  if (dnsCache.size > 500) dnsCache.clear();
  dnsCache.set(hostname, { safe, until: Date.now() + 60000 });
  if (!safe) throw new Error('Hôte DNS privé ou non résolu');
}

export async function validateProxyConfiguration(input) {
  const scheme = String(input?.scheme || 'http').toLowerCase();
  const host = String(input?.host || '').trim().replace(/^\[|\]$/g, '').toLowerCase();
  const port = Number(input?.port);
  const username = String(input?.username || '');
  const password = String(input?.password || '');
  if (!['http', 'https', 'socks5'].includes(scheme) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new HttpError(400, 'Vérifiez le type et le port du proxy.');
  }
  if (!host || host.length > 253 || /[\s/@?#]/.test(host) || isBlockedHostname(host) || (isIP(host) && isPrivateIp(host))) {
    throw new HttpError(400, 'Hôte de proxy invalide.');
  }
  if (!username.trim() || username.length > 512 || !password || password.length > 512) {
    throw new HttpError(400, 'Saisissez les identifiants Webshare; ils seront conservés chiffrés côté serveur.');
  }
  // Resolve the endpoint once to reject localhost/private proxy destinations.
  if (!isIP(host)) {
    let addresses;
    try { addresses = await lookup(host, { all: true, verbatim: true }); } catch { addresses = []; }
    if (!addresses.length || addresses.some((item) => isPrivateIp(item.address))) {
      throw new HttpError(400, 'L’hôte du proxy doit pointer vers une adresse publique.');
    }
  }
  return { scheme, host, port, username, password };
}

export function getSensitiveLabelReason(label) {
  const normalized = String(label || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const patterns = [
    /\b(?:login|log in|sign in|connexion|se connecter|connecter|s[’']?identifier)\b/,
    /\b(?:sign up|register|inscription|creer un compte|ouvrir un compte)\b/,
    /\b(?:buy|purchase|checkout|payer|paiement|commander|acheter|subscribe|abonnement)\b/,
    /\b(?:delete|supprimer|desactiver|logout|deconnexion|log out)\b/,
    /\b(?:confirm|confirmer|valider|submit|envoyer|send|continuer|publish|publier|post|poster|follow|suivre|like|aimer|comment|commenter)\b/,
    /\b(?:password|mot de passe|otp|code|verification|verify|2fa|authentification)\b/,
  ];
  return patterns.some((pattern) => pattern.test(normalized));
}

export function randomExecutionCount(target) {
  const min = Math.max(1, target.execution_target - 10);
  const max = target.execution_target + 10;
  return randomInt(min, max + 1);
}

export function buildRandomRunTimes(count, durationWeeks, startAt = Date.now()) {
  const times = [startAt];
  if (count <= 1) return times;
  const durationMs = durationWeeks * 7 * 24 * 60 * 60 * 1000;
  const minimumGapMs = 5 * 60 * 1000;
  const gapCount = count;
  const extraMs = durationMs - gapCount * minimumGapMs;
  if (extraMs < 0) throw new HttpError(400, 'La durée est trop courte pour les intervalles minimaux.');
  const weights = Array.from({ length: gapCount }, () => -Math.log(Math.max(Math.random(), Number.MIN_VALUE)));
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  let elapsed = 0;
  let allocated = 0;
  for (let index = 0; index < gapCount; index += 1) {
    const extra = index === gapCount - 1 ? extraMs - allocated : extraMs * weights[index] / total;
    allocated += extra;
    elapsed += minimumGapMs + extra;
    if (index < count - 1) times.push(startAt + Math.round(elapsed));
  }
  return times;
}

export function safeErrorMessage(error) {
  const message = String(error?.message || 'Échec du cycle.');
  return message.replace(/https?:\/\/[^\s]+/gi, '[URL]').slice(0, 240);
}

export function validateUuid(value) {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
