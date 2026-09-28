#!/usr/bin/env bash
#
# Idempotent .env editor. USE THIS INSTEAD OF UPLOADING A WHOLE .env FILE.
#
#   ./scripts/set-env.sh STAKES3_PASSWORD 'Smtp123!'
#   ./scripts/set-env.sh --show STAKES3_PASSWORD      # verdict only, no value
#
# Why this exists: the local and production .env files are NOT interchangeable.
# Three keys differ by design, and copying the local file over the server's
# overwrites them with values that look fine until the next deploy rebuilds the
# web container and it can no longer authenticate to Postgres.
#
# That exact mistake happened once and cost a silent outage: the runner kept
# passing its checks while the web container rejected every result with 401,
# so cron reported rc=0 and the dashboard quietly stopped updating.
#
# Replaces the key if present, appends it if not — never leaves duplicates.
# (Duplicates are not fatal, since docker compose takes the last occurrence,
# but a file where you cannot tell which value is live is its own hazard.)
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${APP_DIR}/.env"

# Keys that legitimately differ between local and production. Setting one of
# these from a copied local file is the failure mode this script exists to
# prevent, so they need --force and a deliberate decision.
#
#   POSTGRES_PASSWORD — the DB volume keeps the password it was created with;
#                       changing .env alone just breaks authentication.
#   INGEST_TOKEN      — web and runner must agree. A mismatch is invisible:
#                       results are rejected 401 and silently dropped.
#   DATABASE_URL      — production must NOT have this at all; compose builds it
#                       from POSTGRES_* and the container hostname.
PROTECTED="POSTGRES_PASSWORD INGEST_TOKEN DATABASE_URL"

usage() {
  echo "usage: set-env.sh [--force] KEY VALUE" >&2
  echo "       set-env.sh --show KEY" >&2
  exit 2
}

FORCE=0
SHOW=0
case "${1:-}" in
  --force) FORCE=1; shift ;;
  --show)  SHOW=1;  shift ;;
  -*)      usage ;;
esac

KEY="${1:-}"
[ -n "$KEY" ] || usage

if [ ! -f "$ENV_FILE" ]; then
  echo "No .env at ${ENV_FILE}" >&2
  exit 1
fi

# --show never prints the value — this is routinely run over SSH and pasted
# into chat, which is how a production token leaked once already.
if [ "$SHOW" -eq 1 ]; then
  if grep -q "^${KEY}=" "$ENV_FILE"; then
    n=$(grep -c "^${KEY}=" "$ENV_FILE")
    len=$(grep "^${KEY}=" "$ENV_FILE" | tail -1 | cut -d= -f2- | wc -c)
    echo "${KEY}: present (${n} occurrence(s), length $((len - 1)))"
  else
    echo "${KEY}: absent"
  fi
  exit 0
fi

# Deliberately `${2-}` not `${2:-}`: an empty value is a legitimate thing to
# set (INGEST_URL is blank in production), but omitting the argument is not.
VALUE="${2-}"
[ "$#" -ge 2 ] || usage

for p in $PROTECTED; do
  if [ "$KEY" = "$p" ] && [ "$FORCE" -ne 1 ]; then
    cat >&2 <<EOF
Refusing to set ${KEY}.

This key differs between local and production on purpose. Copying a local
value onto the server breaks the dashboard on the next deploy — and does so
silently, because running containers keep their old environment until they
are recreated.

If you genuinely mean to change it here, re-run with --force.
EOF
    exit 1
  fi
done

cp "$ENV_FILE" "${ENV_FILE}.bak"
grep -v "^${KEY}=" "${ENV_FILE}.bak" > "${ENV_FILE}.tmp"
printf '%s=%s\n' "$KEY" "$VALUE" >> "${ENV_FILE}.tmp"
# `mv -f`: root commonly has mv aliased to `mv -i`, which prompts and then
# silently does nothing when the answer is empty — leaving the edit unapplied
# while appearing to have run.
mv -f "${ENV_FILE}.tmp" "$ENV_FILE"

echo "set ${KEY} (previous file saved to ${ENV_FILE}.bak)"
