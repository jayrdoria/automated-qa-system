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
  { id: "FR", label: "France" },
  { id: "DE", label: "Germany" },
  { id: "IT", label: "Italy" },
  { id: "ES", label: "Spain" },
] as const;

export type RegionId = (typeof REGIONS)[number]["id"];

/// X7 is deferred behind its Cloudflare challenge; shown as such, not as failing.
export const DEFERRED_BRANDS: string[] = ["x7"];
