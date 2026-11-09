import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import { HttpError } from './errors.js';

const DNS_TTL_MS = 60000;
const dnsCache = new Map();

export function isPrivateIpv4(address) {
  const parts = String(address).split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b, c] = parts;
  return a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) || (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113);
}

export function isPrivateIp(address) {
  const version = isIP(address);
  if (version === 4) return isPrivateIpv4(address);
  if (version !== 6) return true;
  const lower = String(address).toLowerCase().split('%')[0];
  if (lower.startsWith('::ffff:')) {
    const mapped = lower.slice('::ffff:'.length);
    if (isIP(mapped) === 4) return isPrivateIpv4(mapped);
    return true;
  }
  // Seul l'IPv6 global-unicast (2000::/3) est accepté.
  return !(lower.startsWith('2') || lower.startsWith('3')) ||
    lower.startsWith('2001:db8:') || lower === '2001:db8::';
}

export function isBlockedHostname(hostname) {
  const host = String(hostname).toLowerCase().replace(/\.$/, '');
  return host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') ||
    host.endsWith('.internal') || host.endsWith('.home.arpa') || host.endsWith('.test') ||
    host.endsWith('.invalid') || host.endsWith('.example');
}

/** Valide une URL de cible saisie par l'utilisateur (HTTP(S), hôte public). */
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

/**
 * Vérifie une URL juste avant une requête réseau (navigation, sous-ressource, clic).
 * Lève une erreur si l'hôte est local, privé, ou résout vers une adresse privée.
 */
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
  dnsCache.set(hostname, { safe, until: Date.now() + DNS_TTL_MS });
  if (!safe) throw new Error('Hôte DNS privé ou non résolu');
}

/** Valide la configuration d'un proxy Webshare (hôte public, identifiants requis). */
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
    throw new HttpError(400, 'Saisissez les identifiants Webshare; ils seront conservés chiffrés sur le VPS.');
  }
  if (!isIP(host)) {
    let addresses;
    try { addresses = await lookup(host, { all: true, verbatim: true }); } catch { addresses = []; }
    if (!addresses.length || addresses.some((item) => isPrivateIp(item.address))) {
      throw new HttpError(400, 'L’hôte du proxy doit pointer vers une adresse publique.');
    }
  }
  return { scheme, host, port, username, password };
}

export function isPrivateHostLiteral(hostname) {
  const host = String(hostname).replace(/^\[|\]$/g, '');
  return isIP(host) ? isPrivateIp(host) : isBlockedHostname(host);
}
