/**
 * Accès à l'API du bot. Toutes les requêtes sont relatives : l'interface est
 * servie par le même serveur que l'API, donc jamais de CORS ni d'URL absolue.
 */
export function createApi(fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== 'function') throw new Error('fetch est indisponible.');

  async function request(path, { method = 'GET', body = null } = {}) {
    const options = { method, headers: {}, credentials: 'same-origin' };
    if (body !== null && body !== undefined) {
      options.headers['content-type'] = 'application/json';
      options.body = JSON.stringify(body);
    }
    let response;
    try {
      response = await fetchImpl(path, options);
    } catch {
      throw new Error('Le serveur ne répond pas. Vérifie que le bot tourne sur le VPS.');
    }
    let payload = null;
    const text = await response.text().catch(() => '');
    if (text) { try { payload = JSON.parse(text); } catch { payload = null; } }
    if (!response.ok) {
      throw new Error(payload?.error || `Erreur ${response.status}.`);
    }
    return payload;
  }

  return {
    request,
    health: () => request('/api/health'),
    me: () => request('/api/auth/me'),
    login: (email, password) => request('/api/auth/login', { method: 'POST', body: { email, password } }),
    register: (email, password, signupCode) => request('/api/auth/register', { method: 'POST', body: { email, password, signupCode } }),
    logout: () => request('/api/auth/logout', { method: 'POST' }),
    visits: () => request('/api/visits'),
    targets: () => request('/api/targets'),
    proxies: () => request('/api/proxies'),
    start: (targetIds, confirmClicks) => request('/api/start', { method: 'POST', body: { targetIds, confirmClicks } }),
  };
}
