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

# The region also selects WHICH DOMAIN is checked — see COLUMNS in
# web/lib/checks.ts and runner/lib/brands.ts:
#   FR, IT -> stakes3.com      DE, ES -> stakes.com      BD -> stakescasino.com
#
# BD is not a market the brand sells to. stakescasino.com is geo-blocked from
# the Singapore VPS like the others, and a Bangladesh exit is simply one that
# reaches it, so it routes through the same tunnel as everything else.
REGION="${1:-FR}"
case "$REGION" in
  FR) COUNTRY="France" ;;
  DE) COUNTRY="Germany" ;;
  IT) COUNTRY="Italy" ;;
  ES) COUNTRY="Spain" ;;
  BD) COUNTRY="Bangladesh" ;;
  *) echo "Unknown region '$REGION' (expected FR|DE|IT|ES|BD)" >&2; exit 2 ;;
esac
# Drop the region arg — anything left is passed through to playwright. Without
# this the region lands in "$@" and docker tries to exec "FR" as the command.
shift || true

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# ── Scheduling model ──────────────────────────────────────────────────────
# Cron ticks every 5 minutes; this script decides whether to actually run.
#
# The interval is measured from the previous run's COMPLETION, not from a fixed
# clock. With fixed :00/:20/:40 ticks, a run that overran by even a minute made
# the next tick collide with itself, flock skipped it, and that region silently
# went 40 minutes between checks instead of 20.
#
# Two guards:
#   MIN_INTERVAL — has enough time passed since this region last finished?
#   GLOBAL lock  — only one region runs at a time, whatever the clock says.
#                  Four concurrent VPN tunnels + browsers would spike RAM on a
#                  box that also runs MailCraft, n8n and two Postgres instances.
# ⚠ DUPLICATED as RUN_INTERVAL_MIN in web/lib/checks.ts. Change one and you must
# change the other, or the dashboard countdown disagrees with the scheduler and
# reports columns as overdue while they are running exactly on time.
MIN_INTERVAL_MIN="${MIN_INTERVAL_MIN:-20}"
STAMP="${APP_DIR}/logs/.last-complete-${REGION}"
LOCK_FILE="/tmp/automated-qa-system.lock"          # global, not per-region
COMPOSE="docker compose -f docker-compose.prod.yml -f docker-compose.vpn.yml"

cd "$APP_DIR"
mkdir -p artifacts logs

export CHECK_REGION="$REGION"
export SERVER_COUNTRIES="$COUNTRY"

# Written by the reporter when an ENTIRE run was refused by Cloudflare and it
# held the results back. MUST match BLOCKED_MARKER in runner/reporter/qa-reporter.ts.
BLOCKED_MARKER="${APP_DIR}/artifacts/.edge-blocked"

# Bring up a fresh tunnel for ${COUNTRY} and wait until it is healthy.
#
# --force-recreate is REQUIRED, not defensive: gluetun persists between runs,
# and a running container keeps the country it started with. Without this the
# DE/IT/ES runs would all silently exit through whichever node FR opened, and
# four "regions" would be one region wearing four hats. It is also what makes
# the blocked-run retry work: a recreated tunnel picks a new exit server.
tunnel_up() {
  $COMPOSE up -d --force-recreate gluetun

  local state=""
  for _ in $(seq 1 30); do
    state=$($COMPOSE ps --format json gluetun 2>/dev/null | grep -o '"Health":"[a-z]*"' | cut -d'"' -f4 || true)
    [ "$state" = "healthy" ] && return 0
    sleep 5
  done
  echo "VPN did not come up for ${COUNTRY} — aborting rather than checking from Singapore"
  $COMPOSE rm -sf gluetun >/dev/null 2>&1 || true
  return 1
}

# Run the suite once through the current tunnel. $1 = DEFER_IF_BLOCKED (1|0).
# --no-deps: gluetun is already up and correct; let compose restart it here
# and it would race with the health gate.
run_suite() {
  local defer="$1"; shift
  $COMPOSE --profile batch run --rm --no-deps -e DEFER_IF_BLOCKED="$defer" runner "$@"
}

run() {
  echo "=== $(date -Is) starting [${REGION} / ${COUNTRY}] ==="

  tunnel_up || return 1
  rm -f "$BLOCKED_MARKER"

  local rc=0
  run_suite 1 "$@" || rc=$?

  # Every check was refused by Cloudflare: the exit IP was flagged, not the
  # site broken. In production that cost ~22 whole runs in two weeks — ~150
  # red rows that said nothing about the site. One retry through a NEW exit
  # server; the retry records its results whatever happens, so a block that
  # persists is still reported rather than hidden.
  if [ -f "$BLOCKED_MARKER" ]; then
    rm -f "$BLOCKED_MARKER"
    echo "$(date -Is) [${REGION}] whole run blocked at Cloudflare — retrying once through a fresh VPN exit"
    if ! tunnel_up; then
      # No stamp: the region stays due and tries again on the next 5-minute
      # tick rather than waiting a full interval with nothing recorded.
      return 1
    fi
    rc=0
    run_suite 0 "$@" || rc=$?
  fi

  # Always tear the tunnel down, pass or fail. Leaving it up pins the next
  # region to this country and holds a VPN session open for nothing.
  $COMPOSE rm -sf gluetun >/dev/null 2>&1 || true

  # Stamp AFTER completion — this is what makes the interval measure from the
  # end of a run rather than its start.
  date +%s > "$STAMP"
  echo "=== $(date -Is) finished [${REGION}] rc=${rc} ==="
  return $rc
}

# Lock on a file descriptor rather than wrapping the whole thing in
# `flock <file> bash -c ...` — that needs the function re-declared inside a
# subshell and quoting breaks the moment an argument contains a space.
# -n = give up immediately rather than queueing behind a stuck run.
# Cheap check first: is this region even due? Done before taking the lock so a
# not-due region never blocks one that is.
if [ -f "$STAMP" ]; then
  elapsed=$(( $(date +%s) - $(cat "$STAMP") ))
  if [ "$elapsed" -lt $(( MIN_INTERVAL_MIN * 60 )) ]; then
    exit 0   # silent: this fires every 5 min by design, logging it is noise
  fi
fi

exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "$(date -Is) [${REGION}] another region is running — will retry next tick"
  exit 0
fi

run "$@"
