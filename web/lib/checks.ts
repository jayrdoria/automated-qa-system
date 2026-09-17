export const BRANDS = ["stakes", "x7"] as const;
export type Brand = (typeof BRANDS)[number];

export const BRAND_LABELS: Record<Brand, string> = {
  stakes: "Stakes.com",
  x7: "X7 Casino",
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
 * Markets the brands serve. Each is a separate cron run through a VPN exit
 * node in that country — the sites localise and gate by IP, so "passing in FR"
 * says nothing about DE.
 */
export const REGIONS = [
  { id: "FR", label: "France", cronOffset: 0 },
  { id: "DE", label: "Germany", cronOffset: 5 },
  { id: "IT", label: "Italy", cronOffset: 10 },
  { id: "ES", label: "Spain", cronOffset: 15 },
] as const;

/**
 * Must match scripts/install-cron.sh. Regions are staggered 5 minutes apart so
 * four VPN tunnels never come up at once on a box that also runs MailCraft and
 * n8n; each region still runs every RUN_INTERVAL_MIN.
 *
 * cronOffset is minutes-past-the-hour, which is timezone-independent for any
 * whole-hour offset — so the browser can compute the next run without knowing
 * the server's timezone.
 */
export const RUN_INTERVAL_MIN = 20;

/**
 * How often cron *offers* a region a chance to run. The region only actually
 * runs if RUN_INTERVAL_MIN has elapsed since it last COMPLETED, so the next run
 * lands on the first tick after it becomes due — not on a fixed clock.
 */
export const CRON_TICK_MIN = 5;

/// How long a run may take before we stop calling it "running" and call it late.
export const RUN_GRACE_MIN = 6;

export type RegionId = (typeof REGIONS)[number]["id"];

/// X7 is deferred behind its Cloudflare challenge; shown as such, not as failing.
export const DEFERRED_BRANDS: string[] = ["x7"];
