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
| `X7_USERNAME` / `X7_PASSWORD` | x7casino2.com (FR) | Optional — only to rotate |
| `X7_DE_USERNAME` / `X7_DE_PASSWORD` | x7casino2.com (DE) | Yes — until set, DE uses the FR account |
| `X7_IT_USERNAME` / `X7_IT_PASSWORD` | x7casino2.com (IT) | Yes — until set, IT uses the FR account |

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

## How alerts decide what to send

**One email per run, sent whenever the run has a failure.** Every red run on the
dashboard has exactly one matching message in Slack. Nothing waits for a second
failure or a re-notify window.

| Situation | Email |
|---|---|
| A run has any failed check | 🔴 FAILING — **one** email listing every failed check, each marked NEW |
| The same checks fail again next run | Again — each marked STILL FAILING with "since" and "Nth run in a row" (🟠 when nothing in the run is new) |
| `site-up` fails | 🔴 SITE DOWN — the other failures in that run are listed in the same email |
| **Every** check fails (even if the homepage loads) | 🔴 SITE DOWN "down or in maintenance" |
| Login fails and takes game-load / cashier with it | All listed in the one email; game-load / cashier marked "likely cause: Login" |
| Checks that were failing pass again | ✅ RECOVERED — **one** email per run listing them |
| Everything passes, nothing was failing | **Nothing** — silence means all good |
| Whole run refused by Cloudflare | Retried once through a new VPN exit; ⛔ BLOCKED for every run that is refused too |
| Some checks refused by Cloudflare in a failing run | Listed as "not tested" in that run's email |

Each failed check in the email shows what broke, a verdict (real site problem vs
network/VPN), its recent history, its own screenshot, and the technical log.

game-load is judged **per run, not per game**: the games are only a rotation.
A failing run alerts (naming the game it tested); the next passing run — any
game — recovers it, and the dashboard cell always shows the latest run. The
dependency chain lives in `web/lib/incidents.ts`.

**Local dev never sends real email.** The Prisma client auto-loads the root
`.env`, which holds the real SMTP credentials, so a local `next dev` has them.
`sendAlert` refuses to send unless `NODE_ENV=production` (set by the web image)
and logs `suppressed alert: …` instead. `ALERT_SEND_IN_DEV=1` overrides this
for a deliberate test — mark such sends `[TEST]`.

## Game rotation

game-load tests one game per run, each on the column's own domain:

- Stakes: Wanted Dead or a Wild, Multifly, Ze Zeus — proven by the provider's
  game id in the frame URL (`…?gameid=NNNN`).
- X7: Wanted Dead or a Wild, Gates of Olympus 2500, Bavarian Riches 3 — proven
  by the `game_name=` parameter of X7's game-wrapper frame.

Every column covers its three games every 75 minutes (25-minute interval), and
columns test different games at the same moment.

To add a game: add it to `STAKES_GAMES` / `X7_GAMES` in `runner/lib/games.ts`
**and** `GAMES` in `web/lib/checks.ts`. Pin one for debugging:

```bash
GAME_OVERRIDE=multifly CHECK_REGION=BD npx playwright test tests/checks/3-game-load.spec.ts
GAME_OVERRIDE=gates-of-olympus-2500 CHECK_REGION=FR CHECK_SITE=x7 npx playwright test tests/checks/3-game-load.spec.ts
```

## X7 Casino (x7casino2.com)

Three columns — **FR, DE, IT** — sharing those exits with Stakes. No ES (geo-
blocked) and no EN/BD column. Each column is its own cron run:

```bash
./scripts/run-checks.sh FR x7      # SITE omitted = the region's Stakes site, as before
```

- **Language comes from the URL, not the IP.** Each column pins `/fr`, `/de` or
  `/it`, so the UI language is deterministic.
- **The home page has a sign-up form** using the same field name and form class
  as the login modal. Every login selector is scoped to `#login-modal`; never
  loosen that, or the check types credentials into registration.
- **`gameplay_blocked`** — X7's launch API (`/player/game/<id>`) refuses
  roughly half of all launches with 403 `gameplay_blocked`, on every account,
  game and country, while the session is valid; the next launch often works.
  game-load therefore relaunches a refused game up to 3 times (20s apart) and
  fails only if every launch is refused — the alert then says "The site refused
  to start the game (…)". Persistent refusals are worth raising with X7.
- **One account per column** (`X7_USERNAME` FR, `X7_DE_*`, `X7_IT_*`) so no
  account is seen logging in from several countries.
- `X7_BASE_URL` is the ORIGIN only (`https://x7casino2.com`); the language
  prefix is added per column. Not synced by deploy, with one exception: the
  deploy rewrites it once if it still holds the old `x7casino.com` host.

## Export

Recent runs → set dates/filters → **Download CSV**. Dates are +08:00 calendar
days, capped at 93 days (retention keeps ~2 months). Same filters as the table.
Rate-limited to 6 exports per minute per client.

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


Selectors for Stakes came from the login screenshot. X7's were measured on the
live x7casino2.com DOM (see the X7 section above).

Once Gate 0 passes:

```bash
npm run check:headed      # watch it drive both sites
npm run check:ui          # time-travel debugger — use this when one fails
```

Fix failures by editing **`runner/lib/brands.ts` only**. Every brand-specific
string lives there; specs stay generic. If you find yourself editing a `.spec.ts`
to fix a selector, the abstraction has leaked — push it back into `brands.ts`.

Prefer, in order: `getByTestId` → `getByRole` → placeholder/text → CSS classes.

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

**Every deploy installs the schedule automatically** (after both deploy gates
pass) — no SSH needed. Edit the schedule in `scripts/install-cron.sh` and push.
The installer touches only its own marked block, verifies every other crontab
job is unchanged (restoring `logs/crontab.bak` if not), and aborts without
writing on an unreadable crontab or unbalanced markers.

Manual use, if ever needed:

```bash
./scripts/install-cron.sh --show    # print what would be installed
./scripts/install-cron.sh           # install; prints the resulting crontab
```

- [ ] Checks appear on the dashboard within 25 minutes unprompted
- [ ] `logs/cron.log` shows clean runs
- [ ] Occasional `flock` exit 1 is fine — it means the guard stopped an overlap.
      Frequent means runs exceed the 25-minute interval; lengthen it.

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
- [ ] Review Slack alert volume after a week — every failing run now emails

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
