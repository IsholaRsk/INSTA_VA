import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 64;
const MAX_MEMORY = 64 * 1024 * 1024;
const BOX_VERSION = 'v1';
const BOX_AAD = Buffer.from('instava.proxy.v1', 'utf8');

function safeEqualBuffers(left, right) {
  if (!Buffer.isBuffer(left) || !Buffer.isBuffer(right) || left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function hashPassword(password) {
  const salt = randomBytes(16);
  const derived = scryptSync(String(password), salt, KEY_LENGTH, {
    N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: MAX_MEMORY,
  });
  return ['scrypt', SCRYPT_N, SCRYPT_R, SCRYPT_P, salt.toString('base64'), derived.toString('base64')].join('$');
}

export function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltB64, hashB64] = parts;
  let expected;
  try { expected = Buffer.from(hashB64, 'base64'); } catch { return false; }
  if (!expected.length) return false;
  let derived;
  try {
    derived = scryptSync(String(password), Buffer.from(saltB64, 'base64'), expected.length, {
      N: Number(n), r: Number(r), p: Number(p), maxmem: MAX_MEMORY,
    });
  } catch {
    return false;
  }
  return safeEqualBuffers(derived, expected);
}

export function randomToken(bytes = 32) {
  return randomBytes(bytes).toString('base64url');
}

export function sha256(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex');
}

export function constantTimeEqual(left, right) {
  return safeEqualBuffers(Buffer.from(String(left), 'utf8'), Buffer.from(String(right), 'utf8'));
}

/**
 * Dérive une clé AES-256 depuis une valeur d'environnement.
 * Une valeur base64/hex de 32 octets est utilisée telle quelle ;
 * une phrase secrète est étirée avec scrypt (sel fixe, la clé ne change jamais).
 */
export function deriveBoxKey(secret) {
  const raw = String(secret || '');
  if (!raw) throw new Error('Clé de chiffrement absente.');
  const candidate = Buffer.from(raw, 'base64');
  if (candidate.length === 32) return candidate;
  if (/^[0-9a-f]{64}$/i.test(raw)) return Buffer.from(raw, 'hex');
  return scryptSync(raw, 'instava-proxy-key-v1', 32, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: MAX_MEMORY });
}

/** Chiffrement authentifié : iv.aléatoire + tag + texte chiffré, encodés en base64url. */
export function encryptSecret(plaintext, secret) {
  const key = deriveBoxKey(secret);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(BOX_AAD);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [BOX_VERSION, iv.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join('.');
}

export function decryptSecret(payload, secret) {
  const parts = String(payload || '').split('.');
  if (parts.length !== 4 || parts[0] !== BOX_VERSION) throw new Error('Secret illisible.');
  const key = deriveBoxKey(secret);
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(parts[1], 'base64url'));
  decipher.setAAD(BOX_AAD);
  decipher.setAuthTag(Buffer.from(parts[2], 'base64url'));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(parts[3], 'base64url')), decipher.final()]);
  return plaintext.toString('utf8');
}

/** Masque un identifiant pour les journaux et l'interface (jamais le secret entier). */
export function maskValue(value) {
  const text = String(value || '');
  if (!text) return '';
  if (text.length <= 4) return '••••';
  return `${text.slice(0, 2)}${'•'.repeat(Math.min(6, text.length - 2))}`;
}
