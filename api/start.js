import { processApprovedVisit } from '../lib/runner.js';
import {
  authenticateUser,
  buildRandomRunTimes,
  HttpError,
  randomExecutionCount,
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
    const [activeRuns, runningVisits] = await Promise.all([
      supabaseTable('instava_mobile_runs', {
        select: 'id', user_id: `eq.${user.id}`, status: 'in.(scheduled,running)', limit: '1',
      }),
      supabaseTable('instava_mobile_visits', {
        select: 'id', user_id: `eq.${user.id}`, status: 'eq.running', limit: '1',
      }),
    ]);
    if (activeRuns.length || runningVisits.length) {
      throw new HttpError(409, 'Une session est déjà en cours. Arrêtez-la ou attendez sa fin avant d’en lancer une autre.');
    }
    const ids = Array.isArray(body.targetIds) ? [...new Set(body.targetIds)] : [];
    if (!ids.length || ids.length > 50 || !ids.every(validateUuid)) {
      throw new HttpError(400, 'Sélectionnez de 1 à 50 cibles valides.');
    }

    const targets = await supabaseTable('instava_mobile_targets', {
      select: 'id,pseudo,url,link_label,execution_target,duration_weeks',
      user_id: `eq.${user.id}`,
      id: `in.(${ids.join(',')})`,
    });
    if (targets.length !== ids.length) throw new HttpError(404, 'Une ou plusieurs cibles sont introuvables.');

    const worstCaseTotal = targets.reduce((sum, target) => sum + Number(target.execution_target) + 10, 0);
    if (worstCaseTotal > 300) {
      throw new HttpError(400, 'La sélection dépasse la limite de 300 visites potentielles.');
    }

    const plannedAt = Date.now();
    const targetSnapshot = Object.fromEntries(targets.map((target) => [target.id, {
      pseudo: target.pseudo,
      url: target.url,
      link_label: target.link_label,
      execution_target: target.execution_target,
      duration_weeks: target.duration_weeks,
    }]));
    const runRows = await supabaseTable('instava_mobile_runs', { select: 'id,status,created_at' }, {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({
        user_id: user.id,
        confirm_clicks: Boolean(body.confirmClicks),
        target_snapshot: targetSnapshot,
        status: 'scheduled',
      }),
    });
    const run = runRows[0];
    if (!run?.id) throw new HttpError(502, 'Impossible de créer la session cloud.');

    const scheduledVisits = [];
    for (const target of targets) {
      const count = randomExecutionCount(target);
      const runTimes = buildRandomRunTimes(count, Number(target.duration_weeks), plannedAt);
      for (let index = 0; index < runTimes.length; index += 1) {
        scheduledVisits.push({
          run_id: run.id,
          user_id: user.id,
          target_id: target.id,
          pseudo_snapshot: target.pseudo,
          visit_number: index + 1,
          scheduled_at: new Date(runTimes[index]).toISOString(),
          status: 'pending',
          result: {},
        });
      }
    }

    let savedVisits;
    try {
      savedVisits = await supabaseTable('instava_mobile_visits', { select: 'id,target_id,visit_number,scheduled_at' }, {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify(scheduledVisits),
      });
    } catch (error) {
      await supabaseTable('instava_mobile_runs', { id: `eq.${run.id}`, user_id: `eq.${user.id}` }, {
        method: 'DELETE', headers: { Prefer: 'return=minimal' },
      }).catch(() => {});
      throw error;
    }

    // Start the first due visits now. Remaining first visits stay due immediately
    // and are picked up by the scheduled worker in bounded batches.
    const firstVisits = savedVisits
      .filter((visit) => visit.visit_number === 1)
      .sort((a, b) => a.scheduled_at.localeCompare(b.scheduled_at))
      .slice(0, 2);
    const started = [];
    for (const visit of firstVisits) started.push(await processApprovedVisit(visit.id));
    return sendJson(res, 201, {
      run: { id: run.id, status: run.status, createdAt: run.created_at },
      plannedVisits: savedVisits.length,
      started: started.filter(Boolean),
    });
  } catch (error) {
    return sendJson(res, error.status || 500, { error: error.message || 'Le lancement a échoué.' });
  }
}
