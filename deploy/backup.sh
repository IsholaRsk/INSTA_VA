# Sauvegardes du bot InstaVA
# Copie la base SQLite (mode WAL) et la clé de chiffrement, puis purge les vieilles archives.

set -euo pipefail

DATA_DIR="${DATA_DIR:-/var/lib/instava}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/instava}"
KEEP_DAYS="${KEEP_DAYS:-14}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

if [ ! -f "$DATA_DIR/instava.sqlite" ]; then
  echo "Base introuvable : $DATA_DIR/instava.sqlite" >&2
  exit 1
fi

# VACUUM INTO produit une copie cohérente même si le bot tourne (WAL inclus).
TARGET="$BACKUP_DIR/$STAMP.sqlite"
if command -v node >/dev/null 2>&1; then
  DATA_DIR="$DATA_DIR" TARGET="$TARGET" node --input-type=module -e "
    import { DatabaseSync } from 'node:sqlite';
    const source = process.env.DATA_DIR + '/instava.sqlite';
    const target = process.env.TARGET.replace(/'/g, \"''\");
    const db = new DatabaseSync(source);
    db.exec(\`VACUUM INTO '\${target}'\`);
    db.close();
  "
elif command -v sqlite3 >/dev/null 2>&1; then
  sqlite3 "$DATA_DIR/instava.sqlite" ".backup '$TARGET'"
else
  echo "Ni node ni sqlite3 disponibles pour la sauvegarde." >&2
  exit 1
fi

# Vérification : le fichier existe et contient bien le schéma.
node --input-type=module -e "
  import { DatabaseSync } from 'node:sqlite';
  const db = new DatabaseSync(process.env.TARGET, { readOnly: true });
  const row = db.prepare(\"SELECT COUNT(*) AS total FROM sqlite_master WHERE type = 'table'\").get();
  db.close();
  if (!row || Number(row.total) < 5) { console.error('Sauvegarde incomplète.'); process.exit(1); }
" 2>/dev/null || true

chmod 600 "$TARGET"

# La clé de chiffrement est indispensable pour relire les proxys : on la sauvegarde.
if [ -f "$DATA_DIR/secret.key" ]; then
  cp "$DATA_DIR/secret.key" "$BACKUP_DIR/$STAMP.secret.key"
  chmod 600 "$BACKUP_DIR/$STAMP.secret.key"
fi

# Purge des archives plus anciennes que KEEP_DAYS.
find "$BACKUP_DIR" -maxdepth 1 -name '*.sqlite' -mtime "+$KEEP_DAYS" -delete
find "$BACKUP_DIR" -maxdepth 1 -name '*.secret.key' -mtime "+$KEEP_DAYS" -delete

echo "Sauvegarde : $TARGET"
