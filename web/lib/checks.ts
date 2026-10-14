/**
 * The brands are mirror sites: the same application served on several domains.
 * `brand` in the database is therefore the DOMAIN id, not a company — stakes,
 * stakes3 and stakescasino are one product behind three hostnames, and the
 * dashboard reports them separately because a mirror can break on its own.
 *
 * x7 is a genuinely different operator (x7casino2.com) with its own table on
 * the dashboard.
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
  x7: "x7casino2.com",
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

export const CHECK_LABELS: Record<string, string> = Object.fromEntries(
  CHECKS.map((c) => [c.id, c.label]),
);

/**
 * Games game-load rotates through, one per run.
 *
 * ⚠ MUST MATCH `STAKES_GAMES` in runner/lib/games.ts (ids and names). The runner
 * picks the game and reports its id as check_run.target; this list only turns
 * that id into a name. An unknown id still works — it just displays raw.
 */
export const GAMES = [
  { id: "wanted-dead-or-a-wild", name: "Wanted Dead or a Wild" },
  { id: "multifly", name: "Multifly" },
  { id: "ze-zeus", name: "Ze Zeus" },
  // X7_GAMES (runner/lib/games.ts). Wanted Dead or a Wild is shared above.
  { id: "gates-of-olympus-2500", name: "Gates of Olympus 2500" },
  { id: "bavarian-riches-3", name: "Bavarian Riches 3" },
] as const;

export function gameName(id: string | null | undefined): string | null {
  if (!id) return null;
  return GAMES.find((g) => g.id === id)?.name ?? id;
}

/**
 * The check every other check depends on. When it fails, the rest of that run
 * failing is a consequence, not six more incidents — alerting and the failures
 * panel collapse them into one.
 */
export const CANARY_CHECK = "site-up";

/**
 * One column of the dashboard = one cron run = one (market, domain) pair.
 *
 * A market can carry more than one column (FR -> stakes3 AND x7), so a column
 * is identified by brand + region, never by region alone. The pairing is fixed
 * here and mirrored in runner/lib/brands.ts. A market is a
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
 *   X7: FR 2,7,...  DE 3,8,...  IT 4,9,...
 * Two columns sharing a minute is fine: the global run lock lets one start and
 * the other takes the next tick.
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
  // Appended after the Stakes columns — order mirrors runner/lib/brands.ts.
  { region: "FR", label: "France", site: "x7", cronOffset: 2 },
  { region: "DE", label: "Germany", site: "x7", cronOffset: 3 },
  { region: "IT", label: "Italy", site: "x7", cronOffset: 4 },
] as const satisfies readonly {
  region: string;
  label: string;
  site: Brand;
  cronOffset: number;
}[];

export type RegionId = (typeof COLUMNS)[number]["region"];

export type Column = (typeof COLUMNS)[number];

/** Stable identity of a column. Region alone is ambiguous (FR has two). */
export function columnKey(c: { site: string; region: string }): string {
  return `${c.site}:${c.region}`;
}

/// Unique regions, for filters — FR appears in two columns.
export const REGIONS = [...new Map(COLUMNS.map((c) => [c.region, c])).values()].map((c) => ({
  region: c.region,
  label: c.label,
}));

/**
 * The dashboard's tables. Stakes mirrors share one matrix (a market is served
 * by one mirror); X7 is a different operator and gets its own.
 */
export const COLUMN_GROUPS: { id: string; title: string; columns: readonly Column[] }[] = [
  { id: "stakes", title: "Stakes", columns: COLUMNS.filter((c) => c.site !== "x7") },
  { id: "x7", title: "X7 Casino", columns: COLUMNS.filter((c) => c.site === "x7") },
];

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
export const RUN_INTERVAL_MIN = 25;

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
 * between runs. Eight columns at a 25-minute interval keep the lock busy
 * ~16 min per cycle, so ~3x the interval leaves room for a column that loses
 * the lock several ticks in a row without crying wolf.
 */
export const STALE_AFTER_MIN = 75;
