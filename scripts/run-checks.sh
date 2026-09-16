#!/usr/bin/env bash
#
# Cron entrypoint. One region per invocation.
#
#   ./scripts/run-checks.sh FR
#
# Wrapped in flock so a hung check can't stack containers until the VPS runs
# out of memory. The lock is PER REGION — FR and DE are independent runs and
# must not block each other, but two FR runs must never overlap.
#
# Routes through the VPN: the VPS is in Singapore and the brands geo-block it,
# so without a French/German/Italian/Spanish exit node every check reports
# EDGE_BLOCKED. Only the runner container is affected — host routing, SSH,
# Apache, MailCraft and n8n are untouched.
set -euo pipefail

REGION="${1:-FR}"
case "$REGION" in
  FR) COUNTRY="France" ;;
  DE) COUNTRY="Germany" ;;
  IT) COUNTRY="Italy" ;;
  ES) COUNTRY="Spain" ;;
  *) echo "Unknown region '$REGION' (expected FR|DE|IT|ES)" >&2; exit 2 ;;
esac

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOCK_FILE="/tmp/automated-qa-system-${REGION}.lock"

cd "$APP_DIR"
mkdir -p artifacts logs

echo "=== $(date -Is) starting check run [${REGION} / ${COUNTRY}] ==="

export CHECK_REGION="$REGION"
export SERVER_COUNTRIES="$COUNTRY"

# -n = fail immediately rather than queueing behind a stuck run.
exec flock -n "$LOCK_FILE" \
  docker compose \
    -f docker-compose.prod.yml \
    -f docker-compose.vpn.yml \
    --profile batch run --rm runner "$@"
