import { test, expect } from "@playwright/test";
import { BRAND_IDS, activeBrands, getBrand } from "../../lib/brands";
import { loginAndVerify } from "../../lib/login";
import { gotoChecked } from "../../lib/preflight";

// Exactly ONE domain runs per region: activeBrands() resolves CHECK_REGION to
// its mirror (FR/IT -> stakes3, DE/ES -> stakes, BD -> stakescasino) and the
// rest skip. The describe-block title stays equal to the brand id, which is
// what the reporter files results under.
for (const id of BRAND_IDS) {
  const enabled = () => activeBrands().includes(id);
  test.describe(id, () => {
    test.skip(() => !enabled(), "not the domain for this CHECK_REGION");
    // Real-play mode needs a session, so this check subsumes login.
    test("game-load", async ({ page }) => {
      const brand = getBrand(id);
      await loginAndVerify(page, brand);
      await gotoChecked(page, brand.gameUrl, 60_000);

      const frame = brand.gameFrame(page);
      await expect(
        frame,
        `${brand.label}: game iframe never appeared`,
      ).toBeVisible({ timeout: 45_000 });

      // Visible-but-collapsed is the common silent failure: the iframe mounts,
      // the game never boots, and a naive visibility assertion passes.
      const box = await frame.boundingBox();
      expect(box, `${brand.label}: game iframe has no layout box`).not.toBeNull();
      expect(
        box!.width,
        `${brand.label}: game iframe collapsed (width ${box!.width})`,
      ).toBeGreaterThan(200);
      expect(
        box!.height,
        `${brand.label}: game iframe collapsed (height ${box!.height})`,
      ).toBeGreaterThan(200);
    });
  });
}
