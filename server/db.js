import { copyFileSync, existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';

/**
 * Schéma SQLite du bot autonome.
 *
 * Le modèle reprend celui de l'ancienne version Supabase (cibles, sessions,
 * visites, proxy), avec trois ajouts issus de l'extension :
 *  - duration_days (durée en jours) et daily_minimum (100 clics/jour) ;
 *  - daily_clicks : journal des clics réellement effectués par jour et par cible ;
 *  - proxy_password chiffré AES-256-GCM, jamais en clair sur le disque.
 *
 * La v2 remplace le proxy unique par une liste illimitée avec rotation.
 */
export const SCHEMA_VERSION = 3;

const MIGRATION_V1 = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'owner' CHECK (role IN ('owner', 'member')),
  created_at TEXT NOT NULL,
  last_login_at TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  user_agent TEXT
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (user_id);

CREATE TABLE IF NOT EXISTS targets (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pseudo TEXT NOT NULL,
  url TEXT NOT NULL,
  link_label TEXT NOT NULL DEFAULT '',
  mode TEXT NOT NULL DEFAULT 'interval' CHECK (mode IN ('interval', 'goal')),
  execution_target INTEGER NOT NULL,
  duration_days INTEGER NOT NULL,
  effective_total INTEGER NOT NULL,
  daily_minimum INTEGER NOT NULL DEFAULT 100,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS targets_user_idx ON targets (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'scheduled'
    CHECK (status IN ('scheduled', 'running', 'completed', 'stopped', 'failed')),
  confirm_clicks INTEGER NOT NULL DEFAULT 0,
  target_snapshot TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS runs_user_idx ON runs (user_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS runs_one_active_per_user
  ON runs (user_id) WHERE status IN ('scheduled', 'running');

CREATE TABLE IF NOT EXISTS visits (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_id TEXT NOT NULL REFERENCES targets(id) ON DELETE CASCADE,
  pseudo_snapshot TEXT NOT NULL,
  visit_number INTEGER NOT NULL,
  scheduled_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'success', 'failed', 'approval_required', 'cancelled')),
  approved_at TEXT,
  started_at TEXT,
  completed_at TEXT,
  result TEXT NOT NULL DEFAULT '{}',
  UNIQUE (run_id, target_id, visit_number)
);
CREATE INDEX IF NOT EXISTS visits_due_idx ON visits (status, scheduled_at);
CREATE INDEX IF NOT EXISTS visits_run_idx ON visits (run_id);
CREATE INDEX IF NOT EXISTS visits_target_idx ON visits (target_id, completed_at DESC);

CREATE TABLE IF NOT EXISTS daily_clicks (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_id TEXT NOT NULL REFERENCES targets(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  clicks INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, target_id, day)
);

CREATE TABLE IF NOT EXISTS proxy_settings (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  scheme TEXT NOT NULL,
  host TEXT NOT NULL,
  port INTEGER NOT NULL,
  username_masked TEXT NOT NULL,
  secret_box TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;


/**
 * v2 : le proxy unique (`proxy_settings`) devient une liste illimitée (`proxies`)
 * avec un état de rotation (`proxy_state`). L'ancien proxy, s'il existait, est
 * repris comme premier élément de la liste pour ne rien perdre au déploiement.
 */
const MIGRATION_V2 = `
CREATE TABLE IF NOT EXISTS proxies (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label TEXT NOT NULL DEFAULT '',
  scheme TEXT NOT NULL,
  host TEXT NOT NULL,
  port INTEGER NOT NULL,
  username_masked TEXT NOT NULL,
  secret_box TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  cycles INTEGER NOT NULL DEFAULT 0,
  successes INTEGER NOT NULL DEFAULT 0,
  failures INTEGER NOT NULL DEFAULT 0,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  last_used_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS proxies_user_idx ON proxies (user_id, created_at);

CREATE TABLE IF NOT EXISTS proxy_state (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 0,
  rotation TEXT NOT NULL DEFAULT 'order' CHECK (rotation IN ('order', 'random')),
  cursor INTEGER NOT NULL DEFAULT 0,
  disable_after INTEGER NOT NULL DEFAULT 3,
  last_proxy_id TEXT,
  updated_at TEXT NOT NULL
);
`;

/**
 * v3 : deux apports pour survivre aux contrôles de Cloudflare.
 *  - proxies.ip_kind / asn / org : nature de l'IP de sortie, pour choisir un
 *    proxy selon son réseau et non selon sa position dans la liste.
 *  - target_sessions : cookies conservés par cible, pour arriver sur le site
 *    comme un visiteur déjà venu (règle 5 : cookies et comportement).
 */
// Les colonnes sont ajoutées une à une après vérification (ALTER TABLE n'est
// pas idempotent) ; la table, elle, est créée avec IF NOT EXISTS.

function columnExists(db, table, column) {
  try {
    return db.prepare(`PRAGMA table_info(${table})`).all().some((row) => row.name === column);
  } catch { return false; }
}

function tableExists(db, name) {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
  return Boolean(row);
}

/**
 * Ouvre la base, applique les migrations manquantes et renvoie une poignée
 * avec les réglages PRAGMA adaptés à un service mono-processus.
 */
export function openDatabase(file, { log = () => {} } = {}) {
  const existed = existsSync(file);
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');

  const current = tableExists(db, 'meta')
    ? Number(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()?.value || 0)
    : 0;

  if (!existed || !current) log(`Initialisation de la base ${path.basename(file)}`);
  if (current < 1) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATION_V1);
      db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '1') ON CONFLICT (key) DO UPDATE SET value = excluded.value").run();
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  if (current < 2) {
    if (current >= 1) log('Migration v2 : liste de proxys avec rotation');
    db.exec('BEGIN');
    try {
      db.exec(MIGRATION_V2);
      // L'ancien proxy unique devient le premier de la liste (identifiants déjà chiffrés).
      if (tableExists(db, 'proxy_settings')) {
        const legacy = db.prepare('SELECT * FROM proxy_settings').all();
        const insert = db.prepare(`INSERT INTO proxies (id, user_id, label, scheme, host, port,
            username_masked, secret_box, enabled, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`);
        const stamp = new Date().toISOString();
        for (const row of legacy) {
          insert.run(`legacy-${row.user_id}`, row.user_id, 'Ancien proxy unique', row.scheme,
            row.host, row.port, row.username_masked, row.secret_box, stamp);
          db.prepare(`INSERT INTO proxy_state (user_id, enabled, rotation, cursor, disable_after, updated_at)
            VALUES (?, 1, 'order', 0, 3, ?) ON CONFLICT (user_id) DO NOTHING`).run(row.user_id, stamp);
        }
        db.exec('DROP TABLE IF EXISTS proxy_settings');
      }
      db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
        .run(String(SCHEMA_VERSION));
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  if (current < 3) {
    if (current >= 1) log('Migration v3 : nature des IP de proxy et sessions par cible');
    db.exec('BEGIN');
    try {
      // ALTER TABLE n'est pas idempotent : on vérifie chaque colonne.
      for (const [column, type] of [['ip_kind', 'TEXT'], ['asn', 'INTEGER'], ['org', 'TEXT'], ['ip_checked_at', 'TEXT']]) {
        if (!columnExists(db, 'proxies', column)) db.exec(`ALTER TABLE proxies ADD COLUMN ${column} ${type}`);
      }
      db.exec(`CREATE TABLE IF NOT EXISTS target_sessions (
        target_id TEXT PRIMARY KEY REFERENCES targets(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        storage TEXT NOT NULL,
        cookie_count INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );`);
      db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
        .run(String(SCHEMA_VERSION));
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  } else if (current > SCHEMA_VERSION) {
    throw new Error(`La base a été créée par une version plus récente (schéma ${current}).`);
  }

  return db;
}

/** Copie de sécurité cohérente (WAL inclus) avant une migration ou sur demande. */
export function backupDatabase(db, file) {
  const target = `${file}.backup-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  return target;
}

export function copyAside(file, suffix = 'bak') {
  const target = `${file}.${suffix}`;
  if (existsSync(file)) copyFileSync(file, target);
  return target;
}
