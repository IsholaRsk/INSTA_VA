import { timingSafeEqual } from 'node:crypto';
import { processDueVisits } from '../lib/runner.js';
import { sendJson } from '../lib/shared.js';

function validCronAuthorization(value, secret) {
  if (!secret || !value) return false;
  const expected = Buffer.from(`Bearer ${secret}`);
  const received = Buffer.from(String(value));
  return expected.length === received.length && timingSafeEqual(expected, received);
}

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return sendJson(res, 405, { error: 'Méthode non autorisée.' });
  }
  if (!validCronAuthorization(req.headers.authorization, process.env.CRON_SECRET)) {
    return sendJson(res, 401, { error: 'Non autorisé.' });
  }
  try {
    const result = await processDueVisits(2);
    return sendJson(res, 200, { ok: true, ...result });
  } catch {
    return sendJson(res, 500, { error: 'Le traitement des cycles dus a échoué.' });
  }
}
