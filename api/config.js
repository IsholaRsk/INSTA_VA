import { getPublicConfig, sendJson } from '../lib/shared.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return sendJson(res, 405, { error: 'Méthode non autorisée.' });
  try {
    return sendJson(res, 200, getPublicConfig());
  } catch {
    return sendJson(res, 503, { error: 'Le service cloud n’est pas encore configuré.' });
  }
}
