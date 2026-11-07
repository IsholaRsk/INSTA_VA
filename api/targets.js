import {
  authenticateUser,
  HttpError,
  normalizeTargetUrl,
  readJson,
  sendJson,
  supabaseTable,
  validateUuid,
} from '../lib/shared.js';

const TARGET_FIELDS = 'id,pseudo,url,link_label,execution_target,duration_weeks,created_at,updated_at';

function validateTarget(body) {
  const pseudo = String(body.pseudo || '').trim();
  const linkLabel = String(body.linkLabel || body.link_label || '').trim();
  const executionTarget = Number(body.executionTarget ?? body.execution_target);
  const durationWeeks = Number(body.durationWeeks ?? body.duration_weeks);
  if (!pseudo || pseudo.length > 60) throw new HttpError(400, 'Le pseudo doit contenir entre 1 et 60 caractères.');
  if (!linkLabel || linkLabel.length > 100) throw new HttpError(400, 'Le libellé du lien doit contenir entre 1 et 100 caractères.');
  if (!Number.isInteger(executionTarget) || executionTarget < 1 || executionTarget > 50) {
    throw new HttpError(400, 'Le nombre visé doit être compris entre 1 et 50.');
  }
  if (!Number.isInteger(durationWeeks) || durationWeeks < 1 || durationWeeks > 52) {
    throw new HttpError(400, 'La durée doit être comprise entre 1 et 52 semaines.');
  }
  return {
    pseudo,
    url: normalizeTargetUrl(body.url),
    link_label: linkLabel,
    execution_target: executionTarget,
    duration_weeks: durationWeeks,
  };
}

export default async function handler(req, res) {
  try {
    const user = await authenticateUser(req);
    if (req.method === 'GET') {
      const targets = await supabaseTable('instava_mobile_targets', {
        select: TARGET_FIELDS,
        user_id: `eq.${user.id}`,
        order: 'created_at.desc',
        limit: '50',
      });
      return sendJson(res, 200, { targets });
    }

    if (req.method === 'POST') {
      const body = await readJson(req);
      const current = await supabaseTable('instava_mobile_targets', {
        select: 'id', user_id: `eq.${user.id}`, limit: '51',
      });
      if (current.length >= 50) throw new HttpError(400, 'Vous avez atteint la limite de 50 cibles.');
      const target = validateTarget(body);
      const created = await supabaseTable('instava_mobile_targets', { select: TARGET_FIELDS }, {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({ ...target, user_id: user.id }),
      });
      return sendJson(res, 201, { target: created[0] });
    }

    if (req.method === 'PATCH') {
      const body = await readJson(req);
      if (!validateUuid(body.id)) throw new HttpError(400, 'Identifiant de cible invalide.');
      const target = validateTarget(body);
      const updated = await supabaseTable('instava_mobile_targets', {
        id: `eq.${body.id}`, user_id: `eq.${user.id}`, select: TARGET_FIELDS,
      }, {
        method: 'PATCH',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({ ...target, updated_at: new Date().toISOString() }),
      });
      if (!updated.length) throw new HttpError(404, 'Cible introuvable.');
      return sendJson(res, 200, { target: updated[0] });
    }

    if (req.method === 'DELETE') {
      const id = String(req.query?.id || '');
      if (!validateUuid(id)) throw new HttpError(400, 'Identifiant de cible invalide.');
      const activeVisits = await supabaseTable('instava_mobile_visits', {
        select: 'id', target_id: `eq.${id}`, user_id: `eq.${user.id}`,
        status: 'in.(pending,running,approval_required)', limit: '1',
      });
      if (activeVisits.length) throw new HttpError(409, 'Arrêtez la session active avant de supprimer cette cible.');
      await supabaseTable('instava_mobile_targets', { id: `eq.${id}`, user_id: `eq.${user.id}` }, {
        method: 'DELETE', headers: { Prefer: 'return=minimal' },
      });
      return sendJson(res, 200, { ok: true });
    }

    res.setHeader('Allow', 'GET, POST, PATCH, DELETE');
    return sendJson(res, 405, { error: 'Méthode non autorisée.' });
  } catch (error) {
    return sendJson(res, error.status || 500, { error: error.message || 'Une erreur est survenue.' });
  }
}
