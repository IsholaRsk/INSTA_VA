/**
 * Limiteur de tentatives en mémoire (fenêtre glissante simple).
 * Protège la connexion et la création de compte contre le bourrage d'identifiants.
 */
export function createRateLimiter({ windowMs = 15 * 60 * 1000, max = 10 } = {}) {
  const hits = new Map();

  function prune(now) {
    if (hits.size < 500) return;
    for (const [key, entry] of hits) {
      if (now - entry.start > windowMs) hits.delete(key);
    }
  }

  return {
    check(key) {
      const now = Date.now();
      prune(now);
      const entry = hits.get(key);
      if (!entry || now - entry.start > windowMs) {
        hits.set(key, { start: now, count: 1 });
        return { allowed: true, retryAfterSeconds: 0 };
      }
      entry.count += 1;
      if (entry.count > max) {
        return { allowed: false, retryAfterSeconds: Math.ceil((entry.start + windowMs - now) / 1000) };
      }
      return { allowed: true, retryAfterSeconds: 0 };
    },
    reset(key) {
      hits.delete(key);
    },
  };
}
