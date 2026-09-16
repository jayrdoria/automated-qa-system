#!/usr/bin/env bash
#
# Retention: keep the CURRENT and PREVIOUS calendar month, delete everything
# older. Running in September keeps September + August and drops July.
#
# Calendar months, not a rolling 30 days, so retention is predictable: on the
# 1st you always still have a full previous month to look back on, rather than
# the window silently shrinking to a few days.
#
# Prunes BOTH sides:
#   - artifacts/ on disk (screenshots, traces — the bulk of the space)
#   - check_run rows in Postgres (the dashboard history)
# Pruning only the disk would leave the DB growing forever behind a dashboard
# that looks fine until queries slow down.
#
# Monthly cron (04:00 — clear of the 03:00 certbot renewal on this box):
#   0 4 1 * * /path/to/scripts/cleanup.sh >> /path/to/logs/cleanup.log 2>&1
#
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$APP_DIR"

# First day of the previous month, 00:00. Anything older than this goes.
CUTOFF="$(date -d "$(date +%Y-%m-01) -1 month" +%Y-%m-%d)"

echo "=== $(date -Is) cleanup — keeping everything from ${CUTOFF} onward ==="

before=$(du -sh artifacts 2>/dev/null | cut -f1 || echo "0")

# --- disk ---
# -newermt compares against the cutoff date directly, so this is month-accurate
# rather than an approximate day count.
find artifacts -mindepth 1 -maxdepth 2 ! -newermt "$CUTOFF" -print -exec rm -rf {} + 2>/dev/null || true

after=$(du -sh artifacts 2>/dev/null | cut -f1 || echo "0")

# --- database ---
if docker ps --format '{{.Names}}' | grep -q '^automated-qa-system-postgres-1$'; then
  DELETED=$(docker exec automated-qa-system-postgres-1 \
    psql -U "${POSTGRES_USER:-qa}" -d "${POSTGRES_DB:-qa_monitor}" -t -A \
    -c "WITH d AS (DELETE FROM check_run WHERE started_at < DATE '${CUTOFF}' RETURNING 1) SELECT count(*) FROM d;" 2>/dev/null || echo "?")
  echo "check_run rows deleted: ${DELETED}"
  # check_state is one row per brand/region/check — bounded and tiny. Never pruned.
else
  echo "postgres container not running — skipped DB prune"
fi

echo "artifacts: ${before} -> ${after}"
echo "disk: $(df -h / | awk 'NR==2 {print $4 " free (" $5 " used)"}')"
