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
  { id: "login", label: "Login" },
  { id: "login-rejects-bad-creds", label: "Bad creds rejected" },
  { id: "game-load", label: "Game load" },
  { id: "providers", label: "Provider list" },
  { id: "chat-widget", label: "Chat widget" },
  { id: "cashier-modal", label: "Cashier modal" },
] as const;

export type CheckId = (typeof CHECKS)[number]["id"];
