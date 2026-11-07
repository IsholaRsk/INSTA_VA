import {
  authenticateUser,
  sendJson,
  supabaseTable,
} from '../lib/shared.js';

export default async function handler(req, res) {
  try {
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      return sendJson(res, 405, { error: 'Méthode non autorisée.' });
    }
    const user = await authenticateUser(req);
    const [visits, runs] = await Promise.all([
      supabaseTable('instava_mobile_visits', {
        select: 'id,run_id,target_id,pseudo_snapshot,visit_number,scheduled_at,status,approved_at,started_at,completed_at,result,created_at',
        user_id: `eq.${user.id}`,
        order: 'created_at.desc,scheduled_at.asc',
        limit: '100',
      }),
      supabaseTable('instava_mobile_runs', {
        select: 'id,status,confirm_clicks,created_at,finished_at',
        user_id: `eq.${user.id}`,
        order: 'created_at.desc',
        limit: '20',
      }),
    ]);
    const targetIds = [...new Set(visits.map((visit) => visit.target_id))];
    let targets = [];
    if (targetIds.length) {
      targets = await supabaseTable('instava_mobile_targets', {
        select: 'id,pseudo', user_id: `eq.${user.id}`, id: `in.(${targetIds.join(',')})`,
      });
    }
    const pseudoById = new Map(targets.map((target) => [target.id, target.pseudo]));
    return sendJson(res, 200, {
      visits: visits.map((visit) => ({
        ...visit,
        pseudo: visit.pseudo_snapshot || pseudoById.get(visit.target_id) || 'Cible supprimée',
      })),
      runs,
    });
  } catch (error) {
    return sendJson(res, error.status || 500, { error: error.message || 'Impossible de charger les cycles.' });
  }
}
