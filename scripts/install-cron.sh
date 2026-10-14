#!/usr/bin/env bash
#
# Phase 3. Idempotent — re-running replaces our entries and leaves any other
# crontab lines (MailCraft, leave-system, backups) untouched.
#
#   ./scripts/install-cron.sh          # install
#   ./scripts/install-cron.sh --show   # print what would be installed
#   ./scripts/install-cron.sh --quiet  # install, one-line summary (used by deploy)
#
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MARKER="# automated-qa-system"

# Cron ticks every 5 minutes; run-checks.sh decides whether a region is due
# (>= 25 min since it last COMPLETED) and takes a global lock so only one runs
# at a time.
#
# Why not fixed :00/:20/:40 — a run that overran made the next tick collide with
# itself, flock skipped it, and that region went 40 minutes between checks. With
# a 5-minute tick the region simply starts at the next opportunity after it is
# due, so an overrun costs minutes instead of a whole cycle.
#
# The 1-minute offsets keep the columns from contending for the lock in the
# same second; the lock makes it correct, the offsets make it tidy.
# The offsets MUST match cronOffset in web/lib/checks.ts (COLUMNS). The UI
# computes "next run" from those; if they drift, the countdown silently lies.
BLOCK="${MARKER} (managed — edit scripts/install-cron.sh, not crontab)
0,5,10,15,20,25,30,35,40,45,50,55 * * * * ${APP_DIR}/scripts/run-checks.sh FR >> ${APP_DIR}/logs/cron-FR.log 2>&1
1,6,11,16,21,26,31,36,41,46,51,56 * * * * ${APP_DIR}/scripts/run-checks.sh DE >> ${APP_DIR}/logs/cron-DE.log 2>&1
2,7,12,17,22,27,32,37,42,47,52,57 * * * * ${APP_DIR}/scripts/run-checks.sh IT >> ${APP_DIR}/logs/cron-IT.log 2>&1
3,8,13,18,23,28,33,38,43,48,53,58 * * * * ${APP_DIR}/scripts/run-checks.sh ES >> ${APP_DIR}/logs/cron-ES.log 2>&1
4,9,14,19,24,29,34,39,44,49,54,59 * * * * ${APP_DIR}/scripts/run-checks.sh BD >> ${APP_DIR}/logs/cron-BD.log 2>&1
2,7,12,17,22,27,32,37,42,47,52,57 * * * * ${APP_DIR}/scripts/run-checks.sh FR x7 >> ${APP_DIR}/logs/cron-FR-x7.log 2>&1
3,8,13,18,23,28,33,38,43,48,53,58 * * * * ${APP_DIR}/scripts/run-checks.sh DE x7 >> ${APP_DIR}/logs/cron-DE-x7.log 2>&1
4,9,14,19,24,29,34,39,44,49,54,59 * * * * ${APP_DIR}/scripts/run-checks.sh IT x7 >> ${APP_DIR}/logs/cron-IT-x7.log 2>&1
0 4 1 * * ${APP_DIR}/scripts/cleanup.sh >> ${APP_DIR}/logs/cleanup.log 2>&1
${MARKER} end"

if [ "${1:-}" = "--show" ]; then
  echo "$BLOCK"
  exit 0
fi

mkdir -p "${APP_DIR}/logs"

# This crontab also carries MailCraft, leave-system and backup jobs. Every guard
# below exists to make sure a bad read can never be written back over them.
#
# 1. Read failure vs "no crontab yet". `crontab -l` exits 1 for both; treating
#    a real read error as empty would replace every other job with ours alone.
if ! current=$(crontab -l 2>"${APP_DIR}/logs/.crontab-read.err"); then
  if grep -qi "no crontab" "${APP_DIR}/logs/.crontab-read.err"; then
    current=""
  else
    echo "ABORT: could not read the current crontab — nothing changed." >&2
    cat "${APP_DIR}/logs/.crontab-read.err" >&2
    exit 1
  fi
fi
rm -f "${APP_DIR}/logs/.crontab-read.err"

# 2. Unbalanced markers. The sed range below deletes from our start marker to
#    our end marker; with the end marker missing it would delete to the END OF
#    THE FILE, taking every job after ours with it.
starts=$(printf '%s\n' "$current" | grep -c "^${MARKER} (managed" || true)
ends=$(printf '%s\n' "$current" | grep -c "^${MARKER} end$" || true)
if [ "$starts" != "$ends" ] || [ "$starts" -gt 1 ]; then
  echo "ABORT: crontab has ${starts} start / ${ends} end markers for this project — fix by hand. Nothing changed." >&2
  exit 1
fi

# 3. Backup, so any mistake is one `crontab <file>` away from undone.
printf '%s\n' "$current" > "${APP_DIR}/logs/crontab.bak"

# Strip any previous block of ours, keep everything else verbatim.
cleaned=$(printf '%s\n' "$current" | sed "\|^${MARKER} (managed|,\|^${MARKER} end$|d")

printf '%s\n%s\n' "$cleaned" "$BLOCK" | sed '/^$/N;/^\n$/D' | crontab -

# 4. Verify: everything that is NOT ours must be exactly what it was.
others_before=$(printf '%s\n' "$cleaned" | grep -v '^$' || true)
others_after=$(crontab -l | sed "\|^${MARKER} (managed|,\|^${MARKER} end$|d" | grep -v '^$' || true)
if [ "$others_before" != "$others_after" ]; then
  echo "ABORT: other crontab entries changed — restoring backup." >&2
  crontab "${APP_DIR}/logs/crontab.bak"
  exit 1
fi

if [ "${1:-}" = "--quiet" ]; then
  # Deploy logs: never print the full crontab — other apps' jobs may carry
  # paths or arguments that do not belong in CI output.
  echo "Installed $(printf '%s\n' "$BLOCK" | grep -c 'run-checks.sh') check schedules (other crontab entries untouched)."
  exit 0
fi

echo "Installed. Current crontab:"
crontab -l
