# Runbook — Phases 7 & 8

Validation and launch. Work top to bottom; each gate assumes the one above passed.

---

## ⛔ Never upload a whole `.env` to the server

The local and production `.env` files are **not interchangeable**. Three keys
differ on purpose:

| Key | Local | Production |
|---|---|---|
| `POSTGRES_PASSWORD` | `qa_local_dev_pw` | real generated secret |
| `INGEST_TOKEN` | any 32+ char string | real generated secret |
| `DATABASE_URL` | `…@localhost:5433/…` | **must not exist** — compose builds it |

Copying the local file over the server's has happened, and the failure is
silent. Running containers keep their environment until recreated, so nothing
looks wrong — meanwhile the runner (recreated on every cron run) starts sending
the local token, web rejects every result with **401**, and the reporter logs it
without failing the run. Cron reports `rc=0`, checks pass, and the dashboard
quietly stops updating. The next deploy then takes web down for real.

To change a value on the server, use the upsert script instead:

```bash
bash scripts/set-env.sh STAKES3_PASSWORD 'the-password'
bash scripts/set-env.sh --show STAKES3_PASSWORD   # verdict only, never the value
```

(Invoked via `bash` because the repo is developed on Windows with
`core.filemode=false`, so the executable bit is not reliably recorded.)

### Brand credentials sync themselves — don't SSH for those

Brand logins are stored as **repository secrets** and written into the server
`.env` automatically on every deploy, before any container is created:

| Secret | Used by | Set it? |
|---|---|---|
| `STAKES3_USERNAME` / `STAKES3_PASSWORD` | stakes3.com (FR, IT) | **Yes — required** |
| `STAKESCASINO_USERNAME` / `STAKESCASINO_PASSWORD` | stakescasino.com (BD) | **Yes — required** |
| `STAKES_USERNAME` / `STAKES_PASSWORD` | stakes.com (DE, ES) | Optional — only to rotate |
| `X7_USERNAME` / `X7_PASSWORD` | x7casino.com | Optional — dormant, x7 has no column |

The last four are **listed but not required**. Because an unset secret is
skipped, leaving them empty means the deploy touches nothing and the values
already on the server keep working. Set one only when you want to rotate that
account — then it is a secret change plus a push, with no SSH.

Repository secrets are encrypted at rest and never appear in the repo or in any
commit. To rotate a brand account: update the secret in
**Settings → Secrets and variables → Actions**, then push. No SSH.

Three safety properties, all verified:

1. **Whitelist** — only the four brand logins are ever written. The
   environment-specific keys are not in the list at all.
2. **Skip empty** — an unset secret arrives as `""`. It is *skipped*, never
   written, because blanking a working credential would break that brand on the
   next cron tick.
3. **Defence in depth** — `set-env.sh` refuses `POSTGRES_PASSWORD`,
   `INGEST_TOKEN` and `DATABASE_URL` regardless, so a mistake in the workflow
   cannot reach them.

Base URLs (`STAKES_BASE_URL`, `X7_BASE_URL`) are **not** synced. They are
configuration rather than credentials, they change almost never, and a wrong one
takes a brand down. Use `set-env.sh` if a host ever moves.

It replaces-or-appends without leaving duplicates, backs up to `.env.bak`, and
refuses the three keys above unless given `--force`.

A guard in `.github/workflows/deploy.yml` also aborts the deploy — before any
docker command runs — if it finds local values on the server, so a slip costs a
failed deploy rather than an outage.

If the values are ever lost, the running containers still hold them:

```bash
docker inspect automated-qa-system-postgres-1 \
  --format '{{range .Config.Env}}{{println .}}{{end}}' | grep POSTGRES_PASSWORD
docker inspect automated-qa-system-web-1 \
  --format '{{range .Config.Env}}{{println .}}{{end}}' | grep INGEST_TOKEN
```

---

## ⛔ Gate 0 — Edge access (BLOCKING)

Nothing below can be validated until this passes. **As of the last check, both
brands return HTTP 403 to the VPS.**

The VPS is in **Singapore** (`194.233.89.28`, Contabo Asia). Stakes and X7 serve
FR/DE/IT/ES and geo-block elsewhere. This is not bot detection — headless and real
headed Chrome are blocked identically, and plain `curl` from the VPS is blocked too.

```bash
# Run from the VPS. Both must return 200.
curl -s -o /dev/null -w "%{http_code}\n" https://www.stakes.com
curl -s -o /dev/null -w "%{http_code}\n" https://x7casino.com
```

Two ways through — either is sufficient:

**A. Cloudflare whitelist** (ticket in flight). The ticket must ask for the IP to
bypass **the country/geo restriction**, not only the WAF or bot rules. An IP
allowlist that still enforces the geo rule will not fix this. Confirm the wording.

**B. VPN egress** — `docker-compose.vpn.yml`, routes only the runner through a
French exit node. See "Enabling the VPN" below.

While blocked, the system behaves correctly: all checks report `EDGE_BLOCKED`, the
dashboard shows them failing, and exactly **one** `[BLOCKED]` alert is sent rather
than fourteen false "feature broken" emails.

---

## Gate 1 — Selector validation

`site-up` is the canary: it is the shallowest check (homepage loads, has a title,
renders a non-empty body) and the one the others are read against. If `site-up`
is red the site is down and every other red is noise; if it is green, a red
below it is a genuinely broken feature.


Selectors for Stakes came from the login screenshot. **X7's are unverified** —
its login is a modal and nobody has seen its DOM.

Once Gate 0 passes:

```bash
npm run check:headed      # watch it drive both sites
npm run check:ui          # time-travel debugger — use this when one fails
```

Fix failures by editing **`runner/lib/brands.ts` only**. Every brand-specific
string lives there; specs stay generic. If you find yourself editing a `.spec.ts`
to fix a selector, the abstraction has leaked — push it back into `brands.ts`.

Expect X7 to need work. Prefer, in order: `getByTestId` → `getByRole` →
placeholder/text → CSS classes.

- [ ] All 14 checks pass twice consecutively
- [ ] `login-rejects-bad-creds` genuinely fails to log in (not just a slow pass)

---

## Gate 2 — Alerting

```bash
# Fill SMTP_HOST / SMTP_USER / SMTP_PASS / ALERT_TO in .env on the VPS first,
# then restart web so it picks them up:
docker compose -f docker-compose.prod.yml up -d --force-recreate web
```

Force a failure — temporarily point `STAKES_BASE_URL` at a bad path, run, revert.

- [ ] Failure email arrives at the Slack channel address
- [ ] **Screenshot attachment renders in Slack.** This is the known-risky one —
      Slack's email-to-channel handling of attachments is inconsistent. If it
      drops or collapses, switch to a Slack incoming webhook.
- [ ] Second consecutive failure sends **no** email (dedup working)
- [ ] Recovery sends exactly one `[RECOVERED]`

---

## Gate 3 — Scheduling

```bash
./scripts/install-cron.sh --show    # review first
./scripts/install-cron.sh           # idempotent; leaves other crontab lines alone
crontab -l
```

- [ ] Checks appear on the dashboard within 20 minutes unprompted
- [ ] `logs/cron.log` shows clean runs
- [ ] Occasional `flock` exit 1 is fine — it means the guard stopped an overlap.
      Frequent means runs exceed the 20-minute interval; lengthen it.

---

## Gate 4 — Parallel running (Phase 7)

Run alongside manual checks for **3–5 days** before trusting alerts.

- [ ] No false positives for 48h straight
- [ ] Slow-but-working pages don't trip timeouts
- [ ] `docker system df` — disk not climbing unexpectedly
- [ ] Monthly cleanup fires (or run `./scripts/cleanup.sh` manually once)

---

## Gate 5 — Launch (Phase 8)

- [ ] Rotate both test account passwords — they were shared in chat
- [ ] Update `.env` on the VPS, restart, confirm login checks still pass
- [ ] Confirm the brands' own fraud/velocity rules tolerate a login every
      20 min from one IP — worth raising in the same Cloudflare ticket
- [ ] Tune `ALERT_RENOTIFY_HOURS` once you see real alert volume

---

## Enabling the VPN

Only the runner container is affected. Host routing, SSH, Apache, MailCraft,
leave-system and n8n are untouched. **Never run a VPN client on the host** — it
would black-hole SSH and take every site down.

1. Get **OpenVPN** credentials from `account.protonvpn.com` → **Account** →
   **OpenVPN / IKEv2 username**.

   ⚠ These are NOT your Proton login. The OpenVPN username is a random string
   (e.g. `aBcD3fGh1JkLmN`) and is **never an email address**. Using the account
   email produces `AUTH_FAILED` even though the tunnel reaches a real FR node —
   which reads like a network fault but is purely a credential-type mistake.

   Also note: **France requires a paid plan.** The free tier only offers US/NL/JP,
   so `SERVER_COUNTRIES: France` will fail to find a server on a free account.

2. No `.ovpn` file needed — gluetun has native ProtonVPN support and ships the
   server list. `SERVER_COUNTRIES` selects the exit region.
3. Add to `.env` **on the VPS** (local `.env` is not used by the server):
   ```
   PROTON_OPENVPN_USER=...
   PROTON_OPENVPN_PASS=...
   ```
4. Verify the exit node before trusting it:
   ```bash
   docker compose -f docker-compose.prod.yml -f docker-compose.vpn.yml \
     --profile batch run --rm --entrypoint sh runner -c "curl -s https://ipinfo.io/country"
   ```
   Must print `FR`. If it prints `SG`, the tunnel isn't up — do not proceed.
5. Point cron at the VPN stack by adding the second `-f` flag in
   `scripts/run-checks.sh`.

---

## Common failures

| Symptom | Cause |
|---|---|
| All checks `EDGE_BLOCKED` | Gate 0 — IP not whitelisted / wrong region |
| One check fails, others pass | Real failure, or a stale selector in `brands.ts` |
| Dashboard shows *Stale* | Cron stopped. Check `logs/cron.log` |
| No alerts but checks fail | SMTP unset — `docker compose logs web \| grep notify` |
| `flock` exit 1 repeatedly | Runs exceed the interval |
| Deploy fails at Gate 2 | Runner image broken — check the Actions log |
