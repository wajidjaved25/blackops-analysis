#!/usr/bin/env bash
# Dumps the Postgres database from the compose stack and keeps the newest KEEP dumps.
# Usage: scripts/backup.sh            (run from anywhere; cron example below)
#   0 3 * * * /opt/usdt-trace/scripts/backup.sh >> /var/log/usdt-backup.log 2>&1
# Restore: gunzip -c backups/usdt_trace-YYYYmmdd-HHMMSS.sql.gz | docker compose exec -T postgres psql -U usdt -d usdt_trace
# Case file uploads live in the "uploads" volume and need their own backup (e.g. docker run --rm -v <project>_uploads:/d -v $PWD/backups:/b alpine tar czf /b/uploads.tgz -C /d .).
set -euo pipefail
cd "$(dirname "$0")/.."

DIR="${BACKUP_DIR:-./backups}"
KEEP="${BACKUP_KEEP:-14}"
mkdir -p "$DIR"

FILE="$DIR/usdt_trace-$(date +%Y%m%d-%H%M%S).sql.gz"
docker compose exec -T postgres pg_dump -U usdt -d usdt_trace --no-owner | gzip > "$FILE.tmp"
mv "$FILE.tmp" "$FILE" # only a complete dump gets the final name
echo "backup written: $FILE ($(du -h "$FILE" | cut -f1))"

# Rotation: delete everything but the newest $KEEP dumps.
ls -1t "$DIR"/usdt_trace-*.sql.gz | tail -n +"$((KEEP + 1))" | xargs -r rm -f --
