#!/usr/bin/env bash
set -euo pipefail

DB="${OPENCODE_DB:-$HOME/.local/share/opencode/opencode.db}"
LOG="${OPENCODE_LOG:-$HOME/.local/share/opencode/log/opencode.log}"
STATE_DIR="$HOME/.local/share/opencode"
OLD_DAYS="${OPENCODE_CLEANUP_DAYS:-60}"
KEEP_RECENT="${OPENCODE_CLEANUP_KEEP:-20}"
DRY_RUN=1
FORCE=0
WAIT=0
VACUUM_ONLY=0
ROTATE_LOG=1
NO_BACKUP=0
AGGRESSIVE=0

for arg in "$@"; do
  case "$arg" in
    --apply) DRY_RUN=0 ;;
    --dry-run) DRY_RUN=1 ;;
    --force) FORCE=1 ;;
    --wait) WAIT=1; DRY_RUN=0 ;;
    --vacuum-only) VACUUM_ONLY=1; DRY_RUN=0 ;;
    --no-backup) NO_BACKUP=1 ;;
    --no-log-rotate) ROTATE_LOG=0 ;;
    --aggressive) AGGRESSIVE=1 ;;
    -h|--help)
      sed -n '2,20p' "$0"
      exit 0
      ;;
    *) echo "argumen tidak dikenal: $arg" >&2; exit 1 ;;
  esac
done

if [[ ! -f "$DB" ]]; then
  echo "DB tidak ditemukan: $DB" >&2
  exit 1
fi

running() {
  pgrep -f 'opencode( |$)' >/dev/null 2>&1
}

if [[ "$WAIT" -eq 1 ]]; then
  echo "[cleanup] menunggu opencode benar-benar tertutup..."
  while running; do sleep 5; done
  echo "[cleanup] opencode tertutup, menunggu 60 detik agar tidak balapan dengan restart..."
  for _ in $(seq 1 12); do
    sleep 5
    if running; then
      echo "[cleanup] opencode dibuka lagi, kembali menunggu..."
      while running; do sleep 5; done
    fi
  done
  echo "[cleanup] aman, mulai."
fi

if [[ "$DRY_RUN" -eq 0 && "$FORCE" -eq 0 ]] && running; then
  echo "[cleanup] opencode masih berjalan. Tutup dulu, atau jalankan dengan --force." >&2
  exit 2
fi

size_mb() { du -m "$1" 2>/dev/null | awk '{print $1}'; }

AGGRESSIVE_CTE=""
AGGRESSIVE_UNION=""
if [[ "$AGGRESSIVE" -eq 1 ]]; then
  AGGRESSIVE_CTE=",
auto AS (
  SELECT s.id FROM session s
  WHERE s.title LIKE 'New session - %'
    AND s.time_updated < (strftime('%s','now') - 14*86400)*1000
    AND s.id NOT IN (SELECT id FROM recent)
    AND s.id NOT IN (SELECT session_id FROM busy)
    AND s.id NOT IN (SELECT parent_id FROM parents)
)"
  AGGRESSIVE_UNION="
UNION ALL
SELECT 'auto' AS reason, id, title, datetime(time_updated/1000,'unixepoch') AS updated
FROM session WHERE id IN (SELECT id FROM auto)"
fi

CANDIDATES_SQL=$(cat <<SQL
WITH recent AS (
  SELECT id FROM session ORDER BY time_updated DESC LIMIT ${KEEP_RECENT}
),
busy AS (
  SELECT DISTINCT session_id FROM todo WHERE status NOT IN ('completed','cancelled')
),
parents AS (
  SELECT DISTINCT parent_id FROM session WHERE parent_id IS NOT NULL
),
empty AS (
  SELECT s.id FROM session s
  WHERE s.title LIKE 'New session%'
    AND COALESCE(s.tokens_input,0)=0
    AND COALESCE(s.tokens_output,0)=0
    AND NOT EXISTS (SELECT 1 FROM message m WHERE m.session_id=s.id)
    AND s.id NOT IN (SELECT id FROM recent)
),
old AS (
  SELECT s.id FROM session s
  WHERE s.time_updated < (strftime('%s','now') - ${OLD_DAYS}*86400)*1000
    AND s.time_updated < (strftime('%s','now') - 7*86400)*1000
    AND s.id NOT IN (SELECT id FROM recent)
    AND s.id NOT IN (SELECT session_id FROM busy)
    AND s.id NOT IN (SELECT parent_id FROM parents)
),
child AS (
  SELECT s.id FROM session s
  WHERE s.parent_id IS NOT NULL
    AND s.time_updated < (strftime('%s','now') - 7*86400)*1000
    AND s.id NOT IN (SELECT id FROM recent)
    AND s.id NOT IN (SELECT session_id FROM busy)
    AND s.id NOT IN (SELECT parent_id FROM parents)
)${AGGRESSIVE_CTE}
SELECT 'empty' AS reason, id, title, datetime(time_updated/1000,'unixepoch') AS updated
FROM session WHERE id IN (SELECT id FROM empty)
UNION ALL
SELECT 'old' AS reason, id, title, datetime(time_updated/1000,'unixepoch') AS updated
FROM session WHERE id IN (SELECT id FROM old)
UNION ALL
SELECT 'child' AS reason, id, title, datetime(time_updated/1000,'unixepoch') AS updated
FROM session WHERE id IN (SELECT id FROM child)${AGGRESSIVE_UNION}
ORDER BY reason, updated
SQL
)

echo "[cleanup] DB: $DB ($(size_mb "$DB") MB)"
echo "[cleanup] kriteria: > ${OLD_DAYS} hari, tidak diubah 7 hari terakhir, bukan ${KEEP_RECENT} terbaru, tanpa todo pending, bukan parent session"
if [[ "$AGGRESSIVE" -eq 1 ]]; then
  echo "[cleanup] aggressive: + session auto-title 'New session - ...' yang >14 hari"
fi
echo

echo "[cleanup] kandidat:"
sqlite3 -header -column "$DB" "$CANDIDATES_SQL"
COUNT=$(sqlite3 "$DB" "SELECT COUNT(DISTINCT id) FROM (${CANDIDATES_SQL});")
echo
echo "[cleanup] total kandidat: $COUNT"

if [[ "$VACUUM_ONLY" -eq 1 ]]; then
  echo "[cleanup] mode vacuum-only"
  sqlite3 "$DB" "PRAGMA busy_timeout=15000; PRAGMA wal_checkpoint(TRUNCATE); VACUUM;"
  echo "[cleanup] selesai. DB sekarang $(size_mb "$DB") MB"
  exit 0
fi

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "[cleanup] dry-run saja. Jalankan dengan --apply untuk mengeksekusi."
  exit 0
fi

if [[ "$COUNT" -eq 0 ]]; then
  echo "[cleanup] tidak ada yang perlu dihapus."
else
  if [[ "$NO_BACKUP" -eq 1 ]]; then
    echo "[cleanup] backup dilewati (--no-backup)."
  else
    BACKUP="$STATE_DIR/opencode.db.bak-$(date +%Y%m%d-%H%M%S)"
    echo "[cleanup] backup ke $BACKUP"
    sqlite3 "$DB" ".backup '$BACKUP'"
    echo "[cleanup] backup selesai ($(size_mb "$BACKUP") MB)"
  fi

  echo "[cleanup] menghapus $COUNT session..."
  {
    echo "PRAGMA foreign_keys=ON;"
    echo "BEGIN IMMEDIATE;"
    echo "CREATE TEMP TABLE doomed(id TEXT PRIMARY KEY);"
    echo "INSERT OR IGNORE INTO doomed SELECT id FROM (${CANDIDATES_SQL});"
    echo "DELETE FROM session WHERE id IN (SELECT id FROM doomed);"
    echo "DELETE FROM event_sequence WHERE aggregate_id IN (SELECT id FROM doomed);"
    echo "COMMIT;"
  } | sqlite3 "$DB"
  echo "[cleanup] hapus selesai."
fi

echo "[cleanup] verifikasi orphan:"
sqlite3 -header -column "$DB" <<'SQL'
SELECT 'message' AS tabel, COUNT(*) AS orphan FROM message WHERE session_id NOT IN (SELECT id FROM session)
UNION ALL SELECT 'part', COUNT(*) FROM part WHERE session_id NOT IN (SELECT id FROM session)
UNION ALL SELECT 'todo', COUNT(*) FROM todo WHERE session_id NOT IN (SELECT id FROM session)
UNION ALL SELECT 'session_message', COUNT(*) FROM session_message WHERE session_id NOT IN (SELECT id FROM session)
UNION ALL SELECT 'session_input', COUNT(*) FROM session_input WHERE session_id NOT IN (SELECT id FROM session)
UNION ALL SELECT 'session_context_epoch', COUNT(*) FROM session_context_epoch WHERE session_id NOT IN (SELECT id FROM session)
UNION ALL SELECT 'event_sequence', COUNT(*) FROM event_sequence WHERE aggregate_id NOT IN (SELECT id FROM session)
UNION ALL SELECT 'event', COUNT(*) FROM event WHERE aggregate_id NOT IN (SELECT aggregate_id FROM event_sequence);
SQL

echo "[cleanup] checkpoint + vacuum (bisa memakan waktu)..."
if sqlite3 "$DB" "PRAGMA busy_timeout=15000; PRAGMA wal_checkpoint(TRUNCATE); VACUUM;"; then
  echo "[cleanup] vacuum selesai. DB sekarang $(size_mb "$DB") MB"
else
  echo "[cleanup] VACUUM gagal (DB masih dipakai?). Jalankan nanti: $0 --vacuum-only" >&2
fi

if [[ "$ROTATE_LOG" -eq 1 && -f "$LOG" ]]; then
  LOG_MB=$(size_mb "$LOG")
  if [[ "$LOG_MB" -gt 5 ]]; then
    echo "[cleanup] rotasi log ($LOG_MB MB -> 5 MB terakhir)"
    tail -c 5000000 "$LOG" > "$LOG.tmp"
    mv "$LOG.tmp" "$LOG"
  fi
fi

echo "[cleanup] selesai."
