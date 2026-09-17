import { test, expect } from "@playwright/test";
import { BRAND_IDS, activeBrands, getBrand } from "../../lib/brands";
import { loginAndVerify } from "../../lib/login";

// X7 skipped while it is Cloudflare-blocked — see activeBrands().
for (const id of BRAND_IDS) {
  const enabled = () => activeBrands().includes(id);
  test.describe(id, () => {
    test.skip(() => !enabled(), "brand deferred (X7_ENABLED=false)");
    // The deposit button only exists for an authenticated user.
    test("cashier-modal", async ({ page }) => {
      const brand = getBrand(id);
      await loginAndVerify(page, brand);

      const modal = brand.cashierModal(page);

      /*
       * Two valid paths to an open cashier, and the site picks for us:
       *
       *  1. It auto-opens after login (first-deposit prompt), or
       *  2. It opens when the deposit button is clicked.
       *
       * Always clicking is wrong. When the prompt has already fired, its
       * backdrop (.experience-cashier-bg) covers the header and swallows the
       * click — Playwright reports "intercepts pointer events" and times out,
       * which reads as a broken cashier when the cashier is in fact open and
       * working. This raced: fast logins hit the prompt, slow ones didn't.
       */
      const alreadyOpen = await modal
        .isVisible()
        .catch(() => false);

      if (!alreadyOpen) {
        const deposit = brand.depositButton(page);
        await expect(
          deposit,
          `${brand.label}: deposit button not found while logged in`,
        ).toBeVisible({ timeout: 30_000 });
        await deposit.click();
      }

      await expect(
        modal,
        `${brand.label}: cashier modal did not open`,
      ).toBeVisible({ timeout: 30_000 });
    });
  });
}
