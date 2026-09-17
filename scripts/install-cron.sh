#!/usr/bin/env bash
#
# Phase 3. Idempotent — re-running replaces our entries and leaves any other
# crontab lines (MailCraft, leave-system, backups) untouched.
#
#   ./scripts/install-cron.sh          # install
#   ./scripts/install-cron.sh --show   # print what would be installed
#
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MARKER="# automated-qa-system"

# Cron ticks every 5 minutes; run-checks.sh decides whether a region is due
# (>= 20 min since it last COMPLETED) and takes a global lock so only one runs
# at a time.
#
# Why not fixed :00/:20/:40 — a run that overran made the next tick collide with
# itself, flock skipped it, and that region went 40 minutes between checks. With
# a 5-minute tick the region simply starts at the next opportunity after it is
# due, so an overrun costs minutes instead of a whole cycle.
#
# The 1-minute offsets keep the four regions from contending for the lock in the
# same second; the lock makes it correct, the offsets make it tidy.
BLOCK="${MARKER} (managed — edit scripts/install-cron.sh, not crontab)
0,5,10,15,20,25,30,35,40,45,50,55 * * * * ${APP_DIR}/scripts/run-checks.sh FR >> ${APP_DIR}/logs/cron-FR.log 2>&1
1,6,11,16,21,26,31,36,41,46,51,56 * * * * ${APP_DIR}/scripts/run-checks.sh DE >> ${APP_DIR}/logs/cron-DE.log 2>&1
2,7,12,17,22,27,32,37,42,47,52,57 * * * * ${APP_DIR}/scripts/run-checks.sh IT >> ${APP_DIR}/logs/cron-IT.log 2>&1
3,8,13,18,23,28,33,38,43,48,53,58 * * * * ${APP_DIR}/scripts/run-checks.sh ES >> ${APP_DIR}/logs/cron-ES.log 2>&1
0 4 1 * * ${APP_DIR}/scripts/cleanup.sh >> ${APP_DIR}/logs/cleanup.log 2>&1
${MARKER} end"

if [ "${1:-}" = "--show" ]; then
  echo "$BLOCK"
  exit 0
fi

mkdir -p "${APP_DIR}/logs"

current=$(crontab -l 2>/dev/null || true)
# Strip any previous block of ours, keep everything else verbatim.
cleaned=$(printf '%s\n' "$current" | sed "\|${MARKER}|,\|${MARKER} end|d")

printf '%s\n%s\n' "$cleaned" "$BLOCK" | sed '/^$/N;/^\n$/D' | crontab -

echo "Installed. Current crontab:"
crontab -l
