import {
  authenticateUser,
  HttpError,
  readJson,
  sendJson,
  supabaseTable,
  validateUuid,
} from '../lib/shared.js';

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return sendJson(res, 405, { error: 'Méthode non autorisée.' });
    }
    const user = await authenticateUser(req);
    const body = await readJson(req);
    if (!validateUuid(body.runId)) throw new HttpError(400, 'Identifiant de session invalide.');

    const runs = await supabaseTable('instava_mobile_runs', {
      select: 'id,status', id: `eq.${body.runId}`, user_id: `eq.${user.id}`, limit: '1',
    });
    if (!runs.length) throw new HttpError(404, 'Session introuvable.');
    if (['completed', 'stopped', 'failed'].includes(runs[0].status)) {
      return sendJson(res, 200, { run: runs[0], message: 'Cette session est déjà terminée.' });
    }

    await supabaseTable('instava_mobile_visits', {
      run_id: `eq.${body.runId}`,
      user_id: `eq.${user.id}`,
      status: 'in.(pending,approval_required)',
    }, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ status: 'cancelled', completed_at: new Date().toISOString(), result: { message: 'Session arrêtée par l’utilisateur.' } }),
    });
    await supabaseTable('instava_mobile_runs', {
      id: `eq.${body.runId}`, user_id: `eq.${user.id}`,
    }, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ status: 'stopped', finished_at: new Date().toISOString() }),
    });
    return sendJson(res, 200, { run: { id: body.runId, status: 'stopped' }, message: 'Les cycles en attente ont été annulés; un cycle déjà en cours pourra se terminer.' });
  } catch (error) {
    return sendJson(res, error.status || 500, { error: error.message || 'Arrêt impossible.' });
  }
}
