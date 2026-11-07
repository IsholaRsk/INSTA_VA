import {
  authenticateUser,
  HttpError,
  readJson,
  sendJson,
  supabaseRpc,
  supabaseTable,
  validateProxyConfiguration,
} from '../lib/shared.js';

export default async function handler(req, res) {
  try {
    const user = await authenticateUser(req);
    if (req.method === 'GET') {
      const rows = await supabaseTable('instava_mobile_proxy_settings', {
        select: 'updated_at', user_id: `eq.${user.id}`, limit: '1',
      });
      return sendJson(res, 200, { configured: Boolean(rows.length), updatedAt: rows[0]?.updated_at || null });
    }

    if (req.method === 'POST') {
      const body = await readJson(req);
      const secret = await validateProxyConfiguration(body);
      await supabaseRpc('instava_replace_proxy_secret', { p_user_id: user.id, p_secret: secret });
      return sendJson(res, 200, { configured: true, message: 'Les identifiants ont été enregistrés dans le coffre chiffré Supabase.' });
    }

    if (req.method === 'DELETE') {
      await supabaseRpc('instava_replace_proxy_secret', { p_user_id: user.id, p_secret: null });
      return sendJson(res, 200, { configured: false });
    }

    res.setHeader('Allow', 'GET, POST, DELETE');
    return sendJson(res, 405, { error: 'Méthode non autorisée.' });
  } catch (error) {
    const status = error instanceof HttpError ? error.status : (error.status || 500);
    return sendJson(res, status, { error: error.message || 'Configuration proxy impossible.' });
  }
}
