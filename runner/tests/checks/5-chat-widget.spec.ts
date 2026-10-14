import { test, expect } from "@playwright/test";
import { BRAND_IDS, activeBrands, getBrand } from "../../lib/brands";
import { gotoChecked } from "../../lib/preflight";

// Exactly ONE domain runs per invocation: activeBrands() resolves CHECK_REGION
// (+ CHECK_SITE) to its column (FR/IT -> stakes3, DE/ES -> stakes,
// BD -> stakescasino, FR/DE/IT + x7 -> x7casino2.com) and the rest skip. The describe-block title stays equal to the brand id, which is
// what the reporter files results under.
for (const id of BRAND_IDS) {
  const enabled = () => activeBrands().includes(id);
  test.describe(id, () => {
    test.skip(() => !enabled(), "not the domain for this CHECK_REGION");
    test("chat-widget", async ({ page }) => {
      const brand = getBrand(id);
      await gotoChecked(page, brand.baseUrl);

      // Zoho SalesIQ injects its loader script immediately but mounts the
      // actual icon well after load, on its own timer. 45s is not generous
      // here — it is the observed floor on Stakes; X7 overrides it.
      const widget = brand.chatWidget(page).first();
      await expect(
        widget,
        `${brand.label}: chat widget never mounted (lower right)`,
      ).toBeVisible({ timeout: brand.chatTimeoutMs ?? 45_000 });

      const box = await widget.boundingBox();
      expect(box, `${brand.label}: chat widget has no layout box`).not.toBeNull();
    });
  });
}
