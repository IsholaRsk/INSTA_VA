import { processApprovedVisit } from '../lib/runner.js';
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
    if (!validateUuid(body.visitId)) throw new HttpError(400, 'Identifiant de cycle invalide.');

    const pending = await supabaseTable('instava_mobile_visits', {
      select: 'id,run_id,target_id,status',
      id: `eq.${body.visitId}`,
      user_id: `eq.${user.id}`,
      status: 'eq.approval_required',
      limit: '1',
    });
    if (!pending.length) throw new HttpError(404, 'Ce cycle ne demande plus de confirmation.');

    await supabaseTable('instava_mobile_visits', {
      id: `eq.${body.visitId}`, user_id: `eq.${user.id}`, status: 'eq.approval_required',
    }, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        status: 'pending',
        scheduled_at: new Date().toISOString(),
        approved_at: new Date().toISOString(),
        result: { message: 'Clic explicitement approuvé.' },
      }),
    });

    const result = await processApprovedVisit(body.visitId);
    return sendJson(res, 200, { result: result || { id: body.visitId, status: 'pending' } });
  } catch (error) {
    return sendJson(res, error.status || 500, { error: error.message || 'Confirmation impossible.' });
  }
}
