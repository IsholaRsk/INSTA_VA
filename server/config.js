import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

const TRUE_VALUES = new Set(['1', 'true', 'oui', 'yes', 'on']);
const FALSE_VALUES = new Set(['0', 'false', 'non', 'no', 'off']);

function readFlag(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (TRUE_VALUES.has(normalized)) return true;
  if (FALSE_VALUES.has(normalized)) return false;
  return fallback;
}

function readInteger(value, fallback, { min, max }) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  const rounded = Math.round(parsed);
  if (rounded < min || rounded > max) return fallback;
  return rounded;
}

/**
 * La clé de chiffrement peut venir de l'environnement. Si elle est absente,
 * on en génère une une seule fois et on la stocke (0600) à côté de la base :
 * le serveur démarre sans configuration, et les sauvegardes restent lisibles.
 */
function resolveSecretKey(dataDir) {
  const fromEnv = String(process.env.INSTAVA_SECRET_KEY || '').trim();
  if (fromEnv) return { key: fromEnv, source: 'env' };
  const keyFile = path.join(dataDir, 'secret.key');
  if (existsSync(keyFile)) {
    const stored = readFileSync(keyFile, 'utf8').trim();
    if (stored) return { key: stored, source: 'file' };
  }
  const generated = randomBytes(32).toString('base64url');
  writeFileSync(keyFile, `${generated}\n`, { mode: 0o600 });
  try { chmodSync(keyFile, 0o600); } catch { /* système de fichiers sans POSIX */ }
  return { key: generated, source: 'generated' };
}

function resolveTimeZone(value) {
  const candidate = String(value || '').trim() || 'Africa/Porto-Novo';
  try {
    new Intl.DateTimeFormat('fr-FR', { timeZone: candidate }).format(new Date());
    return candidate;
  } catch {
    return 'UTC';
  }
}

/**
 * Charge la configuration du serveur autonome.
 * Aucun secret n'est journalisé : seule l'origine de la clé est exposée.
 */
export function loadConfig(env = process.env) {
  const port = readInteger(env.PORT, 8080, { min: 1, max: 65535 });
  const host = String(env.HOST || '0.0.0.0').trim() || '0.0.0.0';
  const dataDir = path.resolve(String(env.DATA_DIR || './data').trim() || './data');
  mkdirSync(dataDir, { recursive: true });

  const databaseFile = path.resolve(env.DATABASE_FILE || path.join(dataDir, 'instava.sqlite'));
  const secret = resolveSecretKey(dataDir);

  return {
    port,
    host,
    dataDir,
    publicDir: path.resolve(env.PUBLIC_DIR || './public'),
    databaseFile,
    secretKey: secret.key,
    secretKeySource: secret.source,
    timeZone: resolveTimeZone(env.INSTAVA_TZ),
    sessionTtlDays: readInteger(env.INSTAVA_SESSION_DAYS, 30, { min: 1, max: 365 }),
    secureCookies: readFlag(env.INSTAVA_SECURE_COOKIES, null),
    allowSignup: readFlag(env.INSTAVA_ALLOW_SIGNUP, true),
    signupCode: String(env.INSTAVA_SIGNUP_CODE || '').trim(),
    chromiumPath: String(env.CHROMIUM_PATH || '').trim() || null,
    headless: readFlag(env.INSTAVA_HEADLESS, true),
    tickMs: readInteger(env.INSTAVA_TICK_MS, 5000, { min: 1000, max: 120000 }),
    maxConcurrentCycles: readInteger(env.INSTAVA_CONCURRENCY, 2, { min: 1, max: 8 }),
    navigationTimeoutMs: readInteger(env.INSTAVA_NAVIGATION_TIMEOUT_MS, 45000, { min: 5000, max: 120000 }),
    // Temps laissé à un challenge Cloudflare pour se résoudre tout seul.
    challengeWaitMs: readInteger(env.INSTAVA_CHALLENGE_WAIT_MS, 15000, { min: 0, max: 60000 }),
    // Délai d'un test de proxy depuis l'interface (IP de sortie).
    proxyTestTimeoutMs: readInteger(env.INSTAVA_PROXY_TEST_TIMEOUT_MS, 8000, { min: 1000, max: 30000 }),
    logLevel: String(env.INSTAVA_LOG_LEVEL || 'info').trim().toLowerCase(),
    version: String(env.INSTAVA_VERSION || '2.0.0'),
    trustProxy: readFlag(env.INSTAVA_TRUST_PROXY, true),
  };
}
