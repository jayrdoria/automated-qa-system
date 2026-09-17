import { test, expect } from "@playwright/test";
import { BRAND_IDS, activeBrands, getBrand } from "../../lib/brands";
import { gotoChecked } from "../../lib/preflight";

// X7 skipped while it is Cloudflare-blocked — see activeBrands().
for (const id of BRAND_IDS) {
  const enabled = () => activeBrands().includes(id);
  test.describe(id, () => {
    test.skip(() => !enabled(), "brand deferred (X7_ENABLED=false)");
    test("providers", async ({ page }) => {
      const brand = getBrand(id);
      await gotoChecked(page, `${brand.baseUrl}${brand.casinoPath}`);

      // The list lives behind a "Providers" toggle — it does not exist in the
      // DOM until opened, so this is a click-then-assert, not a static check.
      await brand.openProviders(page);

      // Count, not visibility: the checkboxes are custom-styled, so the real
      // <input> elements are never "visible" to Playwright even with the panel
      // open. Polling on count also covers "populated, not merely present" —
      // an empty panel renders fine and would otherwise pass while broken.
      const tiles = brand.providerTiles(page);
      await expect
        .poll(() => tiles.count(), {
          message: `${brand.label}: provider panel opened but stayed empty`,
          timeout: 20_000,
        })
        .toBeGreaterThan(5);
    });
  });
}
