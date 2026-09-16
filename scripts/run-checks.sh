#!/usr/bin/env bash
#
# Cron entrypoint. One region per invocation:  ./scripts/run-checks.sh FR
#
# Per-region flock: FR and DE are independent runs and must not block each
# other, but two FR runs must never overlap.
#
# Routes through a VPN exit node in the target country. The VPS is in Singapore
# and the brands geo-block it, so without this every check reports EDGE_BLOCKED.
# Only the runner's network namespace is affected — host routing, SSH, Apache,
# MailCraft and n8n are untouched.
set -euo pipefail

REGION="${1:-FR}"
case "$REGION" in
  FR) COUNTRY="France" ;;
  DE) COUNTRY="Germany" ;;
  IT) COUNTRY="Italy" ;;
  ES) COUNTRY="Spain" ;;
  *) echo "Unknown region '$REGION' (expected FR|DE|IT|ES)" >&2; exit 2 ;;
esac
# Drop the region arg — anything left is passed through to playwright. Without
# this the region lands in "$@" and docker tries to exec "FR" as the command.
shift || true

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOCK_FILE="/tmp/automated-qa-system-${REGION}.lock"
COMPOSE="docker compose -f docker-compose.prod.yml -f docker-compose.vpn.yml"

cd "$APP_DIR"
mkdir -p artifacts logs

export CHECK_REGION="$REGION"
export SERVER_COUNTRIES="$COUNTRY"

run() {
  echo "=== $(date -Is) starting [${REGION} / ${COUNTRY}] ==="

  # --force-recreate is REQUIRED, not defensive: gluetun persists between runs,
  # and a running container keeps the country it started with. Without this the
  # DE/IT/ES runs would all silently exit through whichever node FR opened, and
  # four "regions" would be one region wearing four hats.
  $COMPOSE up -d --force-recreate gluetun

  # Wait for the tunnel before driving a browser through it.
  for _ in $(seq 1 30); do
    state=$($COMPOSE ps --format json gluetun 2>/dev/null | grep -o '"Health":"[a-z]*"' | cut -d'"' -f4 || true)
    [ "$state" = "healthy" ] && break
    sleep 5
  done
  if [ "${state:-}" != "healthy" ]; then
    echo "VPN did not come up for ${COUNTRY} — aborting rather than checking from Singapore"
    $COMPOSE rm -sf gluetun >/dev/null 2>&1 || true
    return 1
  fi

  # --no-deps: gluetun is already up and correct; let compose restart it here
  # and it would race with the health gate above.
  local rc=0
  $COMPOSE --profile batch run --rm --no-deps runner "$@" || rc=$?

  # Always tear the tunnel down, pass or fail. Leaving it up pins the next
  # region to this country and holds a VPN session open for nothing.
  $COMPOSE rm -sf gluetun >/dev/null 2>&1 || true
  echo "=== $(date -Is) finished [${REGION}] rc=${rc} ==="
  return $rc
}

# Lock on a file descriptor rather than wrapping the whole thing in
# `flock <file> bash -c ...` — that needs the function re-declared inside a
# subshell and quoting breaks the moment an argument contains a space.
# -n = give up immediately rather than queueing behind a stuck run.
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "$(date -Is) [${REGION}] previous run still going — skipping this tick"
  exit 0
fi

run "$@"
