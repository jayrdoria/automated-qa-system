#!/usr/bin/env bash
#
# Cron entrypoint. Wrapped in flock so a hung check (slow game load, stalled
# browser) can't stack containers until the VPS runs out of memory.
#
#   */20 * * * * /home/admin/automated-qa-system/scripts/run-checks.sh >> /home/admin/automated-qa-system/logs/cron.log 2>&1
#
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOCK_FILE="/tmp/automated-qa-system.lock"

cd "$APP_DIR"
mkdir -p artifacts logs

echo "=== $(date -Is) starting check run ==="

# -n = fail immediately rather than queueing behind the stuck run.
# --profile batch because `runner` is excluded from `up -d` by default.
exec flock -n "$LOCK_FILE" \
  docker compose -f docker-compose.prod.yml --profile batch run --rm runner "$@"
