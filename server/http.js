import { createReadStream, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { HttpError } from './errors.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
};

export const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
  ].join('; '),
};

export function applySecurityHeaders(res) {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
}

export function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Content-Length', Buffer.byteLength(body));
  res.end(body);
}

export function sendText(res, status, text, type = 'text/plain; charset=utf-8') {
  res.statusCode = status;
  res.setHeader('Content-Type', type);
  res.setHeader('Cache-Control', 'no-store');
  res.end(text);
}

export async function readJsonBody(req, maxBytes = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new HttpError(413, `Envoi trop volumineux (limite ${Math.round(maxBytes / 1024)} Ko). Découpe la liste ou importe le fichier par lots successifs.`);
    chunks.push(chunk);
  }
  if (!size) return {};
  let parsed;
  try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new HttpError(400, 'Corps JSON invalide.'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new HttpError(400, 'Corps JSON invalide.');
  }
  return parsed;
}

/** Sert un fichier statique avec protection contre la traversée de répertoire. */
export function serveStatic(req, res, rootDir, urlPath) {
  let decoded;
  try { decoded = decodeURIComponent(urlPath.split('?')[0]); }
  catch { sendText(res, 400, 'Chemin invalide.'); return true; }
  if (decoded.includes('\0')) { sendText(res, 400, 'Chemin invalide.'); return true; }
  const relative = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  const root = path.resolve(rootDir);
  const resolved = path.resolve(root, relative);
  // Un « .. » décodé ne doit jamais sortir du dossier public.
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    sendText(res, 403, 'Accès refusé.');
    return true;
  }
  if (!existsSync(resolved) || !statSync(resolved).isFile()) return false;
  const extension = path.extname(resolved).toLowerCase();
  const type = MIME[extension] || 'application/octet-stream';
  const stats = statSync(resolved);
  res.statusCode = 200;
  res.setHeader('Content-Type', type);
  res.setHeader('Cache-Control', extension === '.html' || relative === 'sw.js'
    ? 'no-cache'
    : 'public, max-age=3600');
  res.setHeader('Content-Length', stats.size);
  if (req.method === 'HEAD') { res.end(); return true; }
  createReadStream(resolved).pipe(res);
  return true;
}

/** Extrait l'IP cliente derrière Caddy (X-Forwarded-For fiable car Caddy est sur la même machine). */
export function clientIp(req, trustProxy = true) {
  if (trustProxy) {
    const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (forwarded) return forwarded;
  }
  return req.socket?.remoteAddress || '';
}
