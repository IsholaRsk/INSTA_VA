import { randomUUID } from 'node:crypto';
import { constantTimeEqual, hashPassword, randomToken, sha256, verifyPassword } from './crypto.js';
import { HttpError } from './errors.js';

const SESSION_COOKIE = 'instava_session';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const MIN_PASSWORD = 10;

function parseCookies(header) {
  const result = {};
  for (const part of String(header || '').split(';')) {
    const index = part.indexOf('=');
    if (index < 1) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (!name) continue;
    try { result[name] = decodeURIComponent(value); } catch { result[name] = value; }
  }
  return result;
}

function sessionCookie(token, config, maxAgeSeconds) {
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (config.secureCookies !== false) parts.push('Secure');
  return parts.join('; ');
}

/**
 * Authentification locale par cookie de session opaque.
 * Seul le SHA-256 du jeton est stocké : une copie de la base ne permet pas
 * de rejouer une session. Le mot de passe est haché avec scrypt.
 */
export function createAuth({ store, config }) {
  const ttlMs = config.sessionTtlDays * 24 * 60 * 60 * 1000;

  function requestMeta(req) {
    return { userAgent: req.headers['user-agent'] || '', ip: req.socket?.remoteAddress || '' };
  }

  function currentSession(req) {
    const cookies = parseCookies(req.headers.cookie);
    const token = cookies[SESSION_COOKIE];
    if (!token) return null;
    const row = store.findSessionByTokenHash(sha256(token));
    if (!row) return null;
    if (Date.parse(row.expires_at) <= Date.now()) {
      store.deleteSession(row.id);
      return null;
    }
    return {
      id: row.id,
      user: { id: row.user_id, email: row.user_email, role: row.user_role },
      expiresAt: row.expires_at,
    };
  }

  function startSession(req, res, user) {
    const token = randomToken(32);
    const id = randomUUID();
    const expiresAt = new Date(Date.now() + ttlMs).toISOString();
    store.createSession({ id, userId: user.id, tokenHash: sha256(token), expiresAt, userAgent: requestMeta(req).userAgent });
    store.touchLogin(user.id);
    store.purgeExpiredSessions();
    res.setHeader('Set-Cookie', sessionCookie(token, config, Math.floor(ttlMs / 1000)));
    return id;
  }

  function endSession(req, res) {
    const session = currentSession(req);
    if (session) store.deleteSession(session.id);
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${config.secureCookies !== false ? '; Secure' : ''}`);
  }

  function requireUser(req) {
    const session = currentSession(req);
    if (!session) throw new HttpError(401, 'Connectez-vous pour continuer.', 'not_authenticated');
    store.touchSession(session.id);
    return session.user;
  }

  function validatePassword(password, confirmation) {
    if (typeof password !== 'string' || password.length < MIN_PASSWORD || password.length > 200) {
      throw new HttpError(400, `Le mot de passe doit contenir au moins ${MIN_PASSWORD} caractères.`);
    }
    if (confirmation !== undefined && password !== confirmation) {
      throw new HttpError(400, 'Les deux mots de passe ne correspondent pas.');
    }
  }

  function validateEmail(email) {
    const value = String(email || '').trim();
    if (value.length > 254 || !EMAIL_RE.test(value)) throw new HttpError(400, 'Adresse e-mail invalide.');
    return value;
  }

  function login(email, password) {
    const user = store.findUserByEmail(validateEmail(email));
    // Toujours exécuter scrypt pour ne pas révéler l'existence du compte par le temps de réponse.
    const stored = user?.password_hash || hashPassword(randomToken(8));
    const valid = verifyPassword(password, stored);
    if (!user || !valid) throw new HttpError(401, 'E-mail ou mot de passe incorrect.', 'bad_credentials');
    return user;
  }

  /**
   * Le premier compte créé devient propriétaire. Ensuite, soit la création est
   * ouverte, soit elle exige un code d'invitation (INSTAVA_SIGNUP_CODE).
   */
  function register({ email, password, signupCode }) {
    const cleanEmail = validateEmail(email);
    validatePassword(password);
    const first = store.countUsers() === 0;
    if (!first && !config.allowSignup) {
      throw new HttpError(403, 'La création de compte est désactivée sur ce serveur.');
    }
    if (!first && config.signupCode && !constantTimeEqual(signupCode || '', config.signupCode)) {
      throw new HttpError(403, 'Code d’invitation invalide.');
    }
    if (store.findUserByEmail(cleanEmail)) {
      throw new HttpError(409, 'Un compte existe déjà avec cette adresse.');
    }
    return store.createUser({ email: cleanEmail, passwordHash: hashPassword(password), role: first ? 'owner' : 'member' });
  }

  function changePassword(user, currentPassword, newPassword, confirmation, keepSessionId = '') {
    const row = store.findUserById(user.id);
    if (!row || !verifyPassword(currentPassword, row.password_hash)) {
      throw new HttpError(403, 'Mot de passe actuel incorrect.');
    }
    validatePassword(newPassword, confirmation);
    store.updateUserPassword(user.id, hashPassword(newPassword));
    // Les autres appareils sont déconnectés ; la session courante reste active.
    store.deleteSessionsForUser(user.id, keepSessionId);
  }

  return {
    SESSION_COOKIE,
    currentSession,
    requireUser,
    startSession,
    endSession,
    login,
    register,
    changePassword,
    validatePassword,
  };
}
