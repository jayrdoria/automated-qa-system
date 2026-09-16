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

# Regions are STAGGERED by 5 minutes, not run together. Each run brings up a
# VPN tunnel and drives a browser for ~2 minutes; firing four at once would
# spike RAM on a box that also runs MailCraft, n8n and two Postgres instances.
# Every region still gets checked every 20 minutes.
#
# Cleanup runs at 04:00, deliberately NOT 03:00 — the existing certbot renewal
# on this box stops nginx at 03:00 and we stay clear of that window.
BLOCK="${MARKER} (managed — edit scripts/install-cron.sh, not crontab)
0,20,40 * * * * ${APP_DIR}/scripts/run-checks.sh FR >> ${APP_DIR}/logs/cron-FR.log 2>&1
5,25,45 * * * * ${APP_DIR}/scripts/run-checks.sh DE >> ${APP_DIR}/logs/cron-DE.log 2>&1
10,30,50 * * * * ${APP_DIR}/scripts/run-checks.sh IT >> ${APP_DIR}/logs/cron-IT.log 2>&1
15,35,55 * * * * ${APP_DIR}/scripts/run-checks.sh ES >> ${APP_DIR}/logs/cron-ES.log 2>&1
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
