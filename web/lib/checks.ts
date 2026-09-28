/**
 * The brands are mirror sites: the same application served on several domains.
 * `brand` in the database is therefore the DOMAIN id, not a company — stakes,
 * stakes3 and stakescasino are one product behind three hostnames, and the
 * dashboard reports them separately because a mirror can break on its own.
 *
 * x7 is a genuinely different operator and stays deferred behind its Cloudflare
 * challenge.
 */
export const BRANDS = ["stakes", "stakes3", "stakescasino", "x7"] as const;
export type Brand = (typeof BRANDS)[number];

export const BRAND_LABELS: Record<Brand, string> = {
  stakes: "Stakes.com",
  stakes3: "Stakes3.com",
  stakescasino: "StakesCasino.com",
  x7: "X7 Casino",
};

/// Shown under each market column so it is obvious at a glance WHICH host a
/// given cell was tested against — the whole point of the mirror split.
export const SITE_DOMAINS: Record<Brand, string> = {
  stakes: "stakes.com",
  stakes3: "stakes3.com",
  stakescasino: "stakescasino.com",
  x7: "x7casino.com",
};

/// Phase 2's check list. The dashboard renders a tile per brand/check pair
/// from this, so a check with no runs yet shows as "no data" rather than
/// silently vanishing from the grid.
export const CHECKS = [
  // First on purpose — it's the canary the rest are read against. Red here
  // means the site is down; red below it means a feature is broken.
  { id: "site-up", label: "Site up" },
  { id: "login", label: "Login" },
  { id: "login-rejects-bad-creds", label: "Bad creds rejected" },
  { id: "game-load", label: "Game load" },
  { id: "providers", label: "Provider list" },
  { id: "chat-widget", label: "Chat widget" },
  { id: "cashier-modal", label: "Cashier modal" },
] as const;

export type CheckId = (typeof CHECKS)[number]["id"];

/**
 * One column of the dashboard = one cron run = one (market, domain) pair.
 *
 * Each market is served by exactly ONE domain, so the pairing is fixed here and
 * both the runner and the dashboard read it from this table. A market is a
 * separate run through a VPN exit node in that country: the sites localise and
 * gate by IP, so "passing in FR" says nothing about DE.
 *
 * BD is not a market the brand sells to — it is simply an exit country from
 * which stakescasino.com is reachable. It earns a column because the site is
 * monitored, not because Bangladesh is a target audience.
 *
 * cronOffset is the minute-past-each-5-minute-tick at which this column is
 * eligible to start, and MUST match scripts/install-cron.sh:
 *   FR 0,5,10,...  DE 1,6,11,...  IT 2,7,12,...  ES 3,8,13,...  BD 4,9,14,...
 *
 * The UI computes "next run" from these. If they drift from the crontab the
 * countdown silently lies — it will look plausible and be wrong by minutes.
 */
export const COLUMNS = [
  { region: "FR", label: "France", site: "stakes3", cronOffset: 0 },
  { region: "DE", label: "Germany", site: "stakes", cronOffset: 1 },
  { region: "IT", label: "Italy", site: "stakes3", cronOffset: 2 },
  { region: "ES", label: "Spain", site: "stakes", cronOffset: 3 },
  { region: "BD", label: "Bangladesh", site: "stakescasino", cronOffset: 4 },
] as const satisfies readonly {
  region: string;
  label: string;
  site: Brand;
  cronOffset: number;
}[];

export type RegionId = (typeof COLUMNS)[number]["region"];

/**
 * Which domain a given market is tested against.
 *
 * Returns undefined for an unknown region rather than defaulting to a site:
 * a typo'd CHECK_REGION silently testing the wrong domain and filing the
 * results under it is far worse than a loud failure.
 */
export function siteForRegion(region: string): Brand | undefined {
  return COLUMNS.find((c) => c.region === region)?.site;
}

/**
 * Must match scripts/install-cron.sh. Columns are staggered a minute apart so
 * five VPN tunnels never come up at once on a box that also runs MailCraft and
 * n8n; each column still runs every RUN_INTERVAL_MIN.
 *
 * cronOffset is minutes-past-the-hour, which is timezone-independent for any
 * whole-hour offset — so the browser can compute the next run without knowing
 * the server's timezone.
 *
 * ⚠ THIS VALUE IS DUPLICATED in scripts/run-checks.sh (MIN_INTERVAL_MIN).
 * Change one and you must change the other, or the countdown and the scheduler
 * disagree and the UI reports regions as overdue while they are running on time.
 */
export const RUN_INTERVAL_MIN = 20;

/**
 * How often cron *offers* a column a chance to run. The column only actually
 * runs if RUN_INTERVAL_MIN has elapsed since it last COMPLETED, so the next run
 * lands on the first tick after it becomes due — not on a fixed clock.
 */
export const CRON_TICK_MIN = 5;

/// How long a run may take before we stop calling it "running" and call it late.
export const RUN_GRACE_MIN = 6;

/**
 * A check whose last run is older than this is reported as stale rather than
 * passing. Without it, a dead cron looks identical to everything being green,
 * which is the most dangerous failure mode a monitoring dashboard has.
 *
 * Lives here rather than in the dashboard because it is a function of
 * RUN_INTERVAL_MIN: every column serialises behind one global lock, so a column
 * that loses the lock for two or three ticks can legitimately go ~40 minutes
 * between runs. The previous 45-minute value was tuned for four columns and
 * would flag a healthy fifth column as stale.
 */
export const STALE_AFTER_MIN = 60;

/// X7 is deferred behind its Cloudflare challenge; shown as such, not as failing.
export const DEFERRED_BRANDS: string[] = ["x7"];
