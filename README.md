# Automated QA System

Playwright-based uptime/behaviour monitoring for **Stakes.com** and **X7 Casino**,
with a dashboard at **https://employee.netovation.eu/automated-qa-system**.

See `Phase by phase Plan.txt` for the full build plan. Current state: **Phase 6
(auto-deploy) + dashboard shell**. The real brand checks (Phase 2) and the SMTP
alerting (Phase 4) are not written yet — the dashboard renders "no data" until
the runner posts its first results.

## Architecture

```
nginx :443  →  Apache :8443  →  web container 127.0.0.1:7071
                                      ↕ (docker network)
                                 postgres          runner (cron, batch)
```

| Service | Type | Notes |
|---|---|---|
| `web` | Long-running | Next.js 15, `basePath: /automated-qa-system`, owns Prisma |
| `postgres` | Long-running | Dedicated — not shared with Mailcraft's instance |
| `runner` | Batch | Playwright 1.63.0, cron + `flock`, `batch` compose profile |

The runner never touches Postgres. It POSTs results to `/api/results` over the
docker network, so Prisma stays out of the ~2 GB Playwright image.

The image tag in [runner/Dockerfile](runner/Dockerfile) **must** match the
`@playwright/test` version in [runner/package.json](runner/package.json).

## One-time VPS setup

Deploy key authenticates as `root`, so `APP_DIR` is `/opt/automated-qa-system` —
deliberately outside the web docroot, since Apache would otherwise serve `.env`.

```bash
cd /opt
git clone https://github.com/jayrdoria/automated-qa-system.git
cd automated-qa-system

cp .env.example .env
chmod 600 .env
openssl rand -hex 32        # paste as INGEST_TOKEN
nano .env                   # set POSTGRES_PASSWORD + INGEST_TOKEN at minimum

mkdir -p artifacts logs
chown -R 1000:1000 artifacts
chmod +x scripts/run-checks.sh
```

Then apply the two server config changes documented in
[apache/automated-qa-system.conf](apache/automated-qa-system.conf) and reload:

```bash
httpd -t && systemctl reload httpd
```

## Required GitHub secrets

| Secret | Value |
|---|---|
| `VPS_HOST` | `194.233.89.28` |
| `VPS_USER` | `root` — the `github_actions` key authenticates as root |
| `VPS_SSH_KEY` | Contents of `~/.ssh/github_actions` |
| `GHCR_TOKEN` | PAT with `read:packages` |

## Deploy flow

Push to `main` →

1. Actions builds three images (`web`, `web:migrate`, `runner`) and pushes to GHCR
2. VPS pulls, starts Postgres, runs `prisma migrate deploy`, restarts `web`
3. **Gate 1** — `/api/health` must answer and reach Postgres
4. **Gate 2** — the runner image must boot and launch Chromium
5. `docker image prune -f` (dangling only — cannot touch Mailcraft or n8n)

Both gates fail the deploy loudly rather than leaving cron to fail silently.

## Cron (only after a green deploy)

```
*/20 * * * * /opt/automated-qa-system/scripts/run-checks.sh >> /opt/automated-qa-system/logs/cron.log 2>&1
```

## Local development

```bash
cd web && npm install && npm run dev        # dashboard
cd runner && npm install && npm run check:smoke
```

## Watch out for

- **The dashboard is public and unauthenticated.** Failure screenshots are
  excluded from it by default (`PUBLIC_SHOW_SCREENSHOTS=false`) because they
  capture logged-in casino account state. Don't flip that without adding auth.
- **`INGEST_TOKEN` is the only thing** protecting the results API from anyone
  writing fake check data. It's a public route through Apache.
- **Port 7071** — 7070 is Mailcraft. Confirmed free at time of writing.
- **RAM.** Box has ~3.7 GB available with Mailcraft, n8n and their Postgres/Redis
  running. Adding Postgres + Next is ~250 MB; a Playwright run spikes ~1 GB briefly.
- **Stale detection.** The dashboard shows a check as *Stale* if its last run is
  over 45 min old. A dead cron otherwise looks identical to everything passing —
  the most dangerous failure mode a monitor can have.
- **`flock` exit code 1** in `logs/cron.log` means the previous run was still
  going. That's the guard working.
- **npm audit** reports 4 high advisories in build-time-only chains (postcss via
  Next's toolchain, deepmerge-ts via the Prisma CLI). Fixes require Next 16 and
  Prisma 8-rc, both outside the pinned stack. Not runtime-reachable here.
