import { test, expect } from "@playwright/test";
import { BRAND_IDS, activeBrands, getBrand } from "../../lib/brands";
import { gotoChecked } from "../../lib/preflight";

// X7 skipped while it is Cloudflare-blocked — see activeBrands().
for (const id of BRAND_IDS) {
  const enabled = () => activeBrands().includes(id);
  test.describe(id, () => {
    test.skip(() => !enabled(), "brand deferred (X7_ENABLED=false)");
    test("chat-widget", async ({ page }) => {
      const brand = getBrand(id);
      await gotoChecked(page, brand.baseUrl);

      // Zoho SalesIQ injects its loader script immediately but mounts the
      // actual icon well after load, on its own timer. 45s is not generous
      // here — it is the observed floor.
      const widget = brand.chatWidget(page).first();
      await expect(
        widget,
        `${brand.label}: chat widget never mounted (lower right)`,
      ).toBeVisible({ timeout: 45_000 });

      const box = await widget.boundingBox();
      expect(box, `${brand.label}: chat widget has no layout box`).not.toBeNull();
    });
  });
}
