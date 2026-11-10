import { randomUUID } from 'node:crypto';
import { HttpError } from './errors.js';

const ISO = () => new Date().toISOString();

function parseJson(text, fallback = {}) {
  if (!text) return fallback;
  try { return JSON.parse(text); } catch { return fallback; }
}

export function publicTarget(row) {
  if (!row) return null;
  return {
    id: row.id,
    pseudo: row.pseudo,
    url: row.url,
    link_label: row.link_label,
    mode: row.mode,
    execution_target: Number(row.execution_target),
    duration_days: Number(row.duration_days),
    effective_total: Number(row.effective_total),
    daily_minimum: Number(row.daily_minimum),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function publicVisit(row) {
  if (!row) return null;
  return {
    id: row.id,
    run_id: row.run_id,
    target_id: row.target_id,
    pseudo: row.pseudo_snapshot,
    visit_number: Number(row.visit_number),
    scheduled_at: row.scheduled_at,
    status: row.status,
    approved_at: row.approved_at,
    started_at: row.started_at,
    completed_at: row.completed_at,
    result: parseJson(row.result),
  };
}

export function publicRun(row) {
  if (!row) return null;
  return {
    id: row.id,
    status: row.status,
    confirm_clicks: Boolean(row.confirm_clicks),
    created_at: row.created_at,
    finished_at: row.finished_at,
    target_snapshot: parseJson(row.target_snapshot),
  };
}

/**
 * Accès aux données. Toutes les méthodes reçoivent l'utilisateur courant en
 * premier argument et filtrent dessus : aucune requête ne peut lire les
 * données d'un autre compte.
 */
export function createStore(db) {
  const stmt = (sql) => db.prepare(sql);

  /** Refuse tôt un paramètre non scalaire : l'erreur SQLite brute est illisible. */
  function bind(statement, params, context = 'requête') {
    const values = Array.isArray(params) ? params : [params];
    for (const value of values) {
      if (value === undefined) throw new Error(`Paramètre indéfini dans ${context}.`);
    }
    return statement.run(...values);
  }

  return {
    raw: db,

    /* ------------------------------- utilisateurs ------------------------------ */
    countUsers() {
      return Number(stmt('SELECT COUNT(*) AS total FROM users').get().total);
    },

    findUserByEmail(email) {
      return stmt('SELECT * FROM users WHERE email = ? COLLATE NOCASE').get(String(email).trim()) || null;
    },

    findUserById(id) {
      return stmt('SELECT * FROM users WHERE id = ?').get(id) || null;
    },

    createUser({ email, passwordHash, role = 'owner' }) {
      const user = { id: randomUUID(), email: String(email).trim(), password_hash: passwordHash, role, created_at: ISO() };
      stmt(`INSERT INTO users (id, email, password_hash, role, created_at)
            VALUES (:id, :email, :password_hash, :role, :created_at)`).run(user);
      return this.findUserById(user.id);
    },

    touchLogin(userId) {
      stmt('UPDATE users SET last_login_at = ? WHERE id = ?').run(ISO(), userId);
    },

    updateUserPassword(userId, passwordHash) {
      stmt('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, userId);
    },

    listUsers() {
      return stmt('SELECT id, email, role, created_at, last_login_at FROM users ORDER BY created_at').all();
    },

    /* -------------------------------- sessions -------------------------------- */
    createSession({ id, userId, tokenHash, expiresAt, userAgent }) {
      const now = ISO();
      stmt(`INSERT INTO sessions (id, user_id, token_hash, created_at, expires_at, last_seen_at, user_agent)
            VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, userId, tokenHash, now, expiresAt, now, String(userAgent || '').slice(0, 300));
    },

    findSessionByTokenHash(tokenHash) {
      return stmt(`SELECT s.*, u.email AS user_email, u.role AS user_role
                   FROM sessions s JOIN users u ON u.id = s.user_id
                   WHERE s.token_hash = ?`).get(tokenHash) || null;
    },

    touchSession(sessionId) {
      stmt('UPDATE sessions SET last_seen_at = ? WHERE id = ?').run(ISO(), sessionId);
    },

    deleteSession(sessionId) {
      stmt('DELETE FROM sessions WHERE id = ?').run(sessionId);
    },

    deleteSessionsForUser(userId, exceptId = '') {
      stmt('DELETE FROM sessions WHERE user_id = ? AND id <> ?').run(userId, exceptId);
    },

    purgeExpiredSessions() {
      const info = stmt('DELETE FROM sessions WHERE expires_at < ?').run(ISO());
      return Number(info.changes || 0);
    },

    /* --------------------------------- cibles --------------------------------- */
    listTargets(userId) {
      return stmt('SELECT * FROM targets WHERE user_id = ? ORDER BY created_at DESC').all(userId).map(publicTarget);
    },

    getTarget(userId, id) {
      return publicTarget(stmt('SELECT * FROM targets WHERE user_id = ? AND id = ?').get(userId, id));
    },

    countTargets(userId) {
      return Number(stmt('SELECT COUNT(*) AS total FROM targets WHERE user_id = ?').get(userId).total);
    },

    createTarget(userId, data) {
      const id = randomUUID();
      const now = ISO();
      stmt(`INSERT INTO targets (id, user_id, pseudo, url, link_label, mode, execution_target,
              duration_days, effective_total, daily_minimum, created_at, updated_at)
            VALUES (:id, :user_id, :pseudo, :url, :link_label, :mode, :execution_target,
              :duration_days, :effective_total, :daily_minimum, :created_at, :updated_at)`).run({
        id, user_id: userId, created_at: now, updated_at: now, ...data,
      });
      return this.getTarget(userId, id);
    },

    updateTarget(userId, id, data) {
      const columns = Object.keys(data);
      if (!columns.length) return this.getTarget(userId, id);
      const assignments = columns.map((column) => `${column} = :${column}`).join(', ');
      stmt(`UPDATE targets SET ${assignments}, updated_at = :updated_at WHERE user_id = :user_id AND id = :id`)
        .run({ ...data, updated_at: ISO(), user_id: userId, id });
      return this.getTarget(userId, id);
    },

    deleteTarget(userId, id) {
      const info = stmt('DELETE FROM targets WHERE user_id = ? AND id = ?').run(userId, id);
      return Number(info.changes || 0) > 0;
    },

    /* --------------------------------- sessions -------------------------------- */
    listRuns(userId, limit = 20) {
      return stmt('SELECT * FROM runs WHERE user_id = ? ORDER BY created_at DESC LIMIT ?')
        .all(userId, limit).map(publicRun);
    },

    getRun(userId, id) {
      return publicRun(stmt('SELECT * FROM runs WHERE user_id = ? AND id = ?').get(userId, id));
    },

    activeRun(userId) {
      return publicRun(stmt("SELECT * FROM runs WHERE user_id = ? AND status IN ('scheduled','running') LIMIT 1").get(userId));
    },

    createRun(userId, { confirmClicks, targetSnapshot }) {
      const id = randomUUID();
      stmt(`INSERT INTO runs (id, user_id, status, confirm_clicks, target_snapshot, created_at)
            VALUES (?, ?, 'scheduled', ?, ?, ?)`)
        .run(id, userId, confirmClicks ? 1 : 0, JSON.stringify(targetSnapshot), ISO());
      return this.getRun(userId, id);
    },

    setRunStatus(runId, status, finishedAt = null) {
      stmt('UPDATE runs SET status = ?, finished_at = ? WHERE id = ?').run(status, finishedAt, runId);
    },

    /* --------------------------------- visites -------------------------------- */
    addVisits(rows) {
      const insert = stmt(`INSERT INTO visits (id, run_id, user_id, target_id, pseudo_snapshot,
              visit_number, scheduled_at, status)
            VALUES (:id, :run_id, :user_id, :target_id, :pseudo_snapshot, :visit_number, :scheduled_at, 'pending')`);
      db.exec('BEGIN');
      try {
        for (const row of rows) insert.run(row);
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
      return rows.length;
    },

    listVisits(userId, { limit = 60, runId = null, status = null } = {}) {
      const filters = ['user_id = :user_id'];
      const params = { user_id: userId, limit };
      if (runId) { filters.push('run_id = :run_id'); params.run_id = runId; }
      if (status) { filters.push('status = :status'); params.status = status; }
      return stmt(`SELECT * FROM visits WHERE ${filters.join(' AND ')}
                   ORDER BY COALESCE(completed_at, started_at, scheduled_at) DESC LIMIT :limit`)
        .all(params).map(publicVisit);
    },

    getVisit(userId, id) {
      return publicVisit(stmt('SELECT * FROM visits WHERE user_id = ? AND id = ?').get(userId, id));
    },

    getVisitById(id) {
      return stmt('SELECT * FROM visits WHERE id = ?').get(id) || null;
    },

    /** Visite due pour un propriétaire : la plus ancienne dont le quota du jour n'est pas atteint. */
    nextDueVisit(userId, nowIso) {
      return stmt(`SELECT * FROM visits
                   WHERE user_id = :user_id AND status = 'pending' AND scheduled_at <= :now
                   ORDER BY scheduled_at ASC LIMIT 1`).get({ user_id: userId, now: nowIso }) || null;
    },

    countPending(userId) {
      return Number(stmt("SELECT COUNT(*) AS total FROM visits WHERE user_id = ? AND status IN ('pending','running','approval_required')")
        .get(userId).total);
    },

    markVisitRunning(visitId) {
      if (!visitId) throw new Error('markVisitRunning : identifiant de visite manquant.');
      const info = stmt(`UPDATE visits SET status = 'running', started_at = ?
                         WHERE id = ? AND status = 'pending'`).run(ISO(), visitId);
      return Number(info.changes || 0) > 0;
    },

    markVisitApproval(visitId, message) {
      stmt(`UPDATE visits SET status = 'approval_required', started_at = NULL, result = ?
            WHERE id = ?`).run(JSON.stringify({ message }), visitId);
    },

    approveVisit(visitId) {
      const info = stmt(`UPDATE visits SET status = 'pending', approved_at = ?, result = '{}'
                         WHERE id = ? AND status = 'approval_required'`).run(ISO(), visitId);
      return Number(info.changes || 0) > 0;
    },

    finishVisit(visitId, status, result) {
      if (!visitId) throw new Error('finishVisit : identifiant de visite manquant.');
      stmt('UPDATE visits SET status = ?, result = ?, completed_at = ? WHERE id = ?')
        .run(status, JSON.stringify(result || {}), ISO(), visitId);
    },

    cancelPendingVisits(userId, runId = null) {
      const sql = runId
        ? "UPDATE visits SET status = 'cancelled', completed_at = ? WHERE user_id = ? AND run_id = ? AND status IN ('pending','approval_required')"
        : "UPDATE visits SET status = 'cancelled', completed_at = ? WHERE user_id = ? AND status IN ('pending','approval_required')";
      const info = runId ? stmt(sql).run(ISO(), userId, runId) : stmt(sql).run(ISO(), userId);
      return Number(info.changes || 0);
    },

    resetStaleRunning(maxAgeMinutes = 10) {
      const threshold = new Date(Date.now() - maxAgeMinutes * 60_000).toISOString();
      const message = JSON.stringify({ message: 'Cycle interrompu par un redémarrage du serveur.' });
      return Number(stmt(`UPDATE visits SET status = 'failed', completed_at = ?, result = ?
                 WHERE status = 'running' AND started_at < ?`).run(ISO(), message, threshold).changes || 0);
    },

    /* ------------------------------ journal de clics --------------------------- */
    clicksOnDay(userId, targetId, day) {
      const row = stmt('SELECT clicks FROM daily_clicks WHERE user_id = ? AND target_id = ? AND day = ?')
        .get(userId, targetId, day);
      return Number(row?.clicks || 0);
    },

    addClick(userId, targetId, day, delta = 1) {
      if (!userId || !targetId) throw new Error('addClick : identifiant manquant.');
      stmt(`INSERT INTO daily_clicks (user_id, target_id, day, clicks, updated_at)
            VALUES (:user_id, :target_id, :day, :delta, :updated_at)
            ON CONFLICT (user_id, target_id, day)
            DO UPDATE SET clicks = clicks + :delta, updated_at = :updated_at`)
        .run({ user_id: userId, target_id: targetId, day, delta, updated_at: ISO() });
    },

    clicksBetween(userId, targetId, fromDay, toDay) {
      const row = stmt(`SELECT COALESCE(SUM(clicks), 0) AS total FROM daily_clicks
                        WHERE user_id = ? AND target_id = ? AND day >= ? AND day <= ?`)
        .get(userId, targetId, fromDay, toDay);
      return Number(row?.total || 0);
    },

    dailyClicksForUser(userId, day) {
      const row = stmt('SELECT COALESCE(SUM(clicks), 0) AS total FROM daily_clicks WHERE user_id = ? AND day = ?')
        .get(userId, day);
      return Number(row?.total || 0);
    },

    dailyClicksByTarget(userId, targetId, limitDays = 14) {
      return stmt(`SELECT day, clicks FROM daily_clicks WHERE user_id = ? AND target_id = ?
                   ORDER BY day DESC LIMIT ?`).all(userId, targetId, limitDays);
    },

    pruneClicksBefore(day) {
      const info = stmt('DELETE FROM daily_clicks WHERE day < ?').run(day);
      return Number(info.changes || 0);
    },

    /* --------------------------------- proxy ---------------------------------- */
    getProxySettings(userId) {
      return stmt('SELECT * FROM proxy_settings WHERE user_id = ?').get(userId) || null;
    },

    saveProxySettings(userId, data) {
      stmt(`INSERT INTO proxy_settings (user_id, scheme, host, port, username_masked, secret_box, updated_at)
            VALUES (:user_id, :scheme, :host, :port, :username_masked, :secret_box, :updated_at)
            ON CONFLICT (user_id) DO UPDATE SET
              scheme = excluded.scheme, host = excluded.host, port = excluded.port,
              username_masked = excluded.username_masked, secret_box = excluded.secret_box,
              updated_at = excluded.updated_at`)
        .run({ user_id: userId, updated_at: ISO(), ...data });
    },

    deleteProxySettings(userId) {
      stmt('DELETE FROM proxy_settings WHERE user_id = ?').run(userId);
    },

    /* ----------------------------- maintenance -------------------------------- */
    stats(userId) {
      const visits = stmt(`SELECT status, COUNT(*) AS total FROM visits WHERE user_id = ? GROUP BY status`).all(userId);
      const counts = Object.fromEntries(visits.map((row) => [row.status, Number(row.total)]));
      return {
        targets: this.countTargets(userId),
        pending: this.countPending(userId),
        visits: counts,
      };
    },

    assertOwned(targetId, userId) {
      const row = stmt('SELECT id FROM targets WHERE id = ? AND user_id = ?').get(targetId, userId);
      if (!row) throw new HttpError(404, 'Cible introuvable.');
    },
  };
}
