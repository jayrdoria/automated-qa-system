import { test, expect } from "@playwright/test";
import { BRAND_IDS, activeBrands, getBrand } from "../../lib/brands";
import { gotoChecked } from "../../lib/preflight";

/**
 * Plain availability — is the site up at all.
 *
 * This is the canary the other checks are read against. When `site-up` is green
 * but `login` is red, the feature is broken. When `site-up` is red too, the site
 * is down and the other failures are noise. Without it every outage looks like
 * six unrelated features breaking simultaneously.
 *
 * Deliberately shallow: no auth, no third-party widgets, nothing that can fail
 * for a reason other than "the site isn't serving".
 */
// Exactly ONE domain runs per invocation: activeBrands() resolves CHECK_REGION
// (+ CHECK_SITE) to its column (FR/IT -> stakes3, DE/ES -> stakes,
// BD -> stakescasino, FR/DE/IT + x7 -> x7casino2.com) and the rest skip. The describe-block title stays equal to the brand id, which is
// what the reporter files results under.
for (const id of BRAND_IDS) {
  const enabled = () => activeBrands().includes(id);
  test.describe(id, () => {
    test.skip(() => !enabled(), "not the domain for this CHECK_REGION");
    test("site-up", async ({ page }) => {
      const brand = getBrand(id);
      const started = Date.now();

      // Throws EdgeBlockedError on a CDN/geo block, which the reporter
      // separates from a genuine outage.
      const res = await gotoChecked(page, brand.baseUrl);
      const elapsed = Date.now() - started;

      expect(
        res?.status(),
        `${brand.label}: homepage returned ${res?.status()}`,
      ).toBeLessThan(400);

      // A 200 that renders an error page or a blank body is still an outage.
      const title = await page.title();
      expect(title.trim(), `${brand.label}: homepage has an empty title`).not.toBe("");
      expect(
        title,
        `${brand.label}: homepage served an error page ("${title}")`,
      ).not.toMatch(/error|unavailable|maintenance|502|503|504/i);

      const bodyText = (await page.locator("body").innerText()).trim();
      expect(
        bodyText.length,
        `${brand.label}: homepage body is effectively empty (${bodyText.length} chars)`,
      ).toBeGreaterThan(200);

      console.log(`[site-up] ${brand.label} responded in ${elapsed}ms`);
    });
  });
}
