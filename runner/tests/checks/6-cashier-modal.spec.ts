import { test, expect } from "@playwright/test";
import { BRAND_IDS, activeBrands, getBrand } from "../../lib/brands";
import { loginAndVerify } from "../../lib/login";

// Exactly ONE domain runs per region: activeBrands() resolves CHECK_REGION to
// its mirror (FR/IT -> stakes3, DE/ES -> stakes, BD -> stakescasino) and the
// rest skip. The describe-block title stays equal to the brand id, which is
// what the reporter files results under.
for (const id of BRAND_IDS) {
  const enabled = () => activeBrands().includes(id);
  test.describe(id, () => {
    test.skip(() => !enabled(), "not the domain for this CHECK_REGION");
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
      /*
       * The check above still lost a race in production: 61 of 61 recorded
       * click timeouts were the cashier's OWN backdrop (.experience-cashier-bg)
       * intercepting the click. The prompt had not appeared when isVisible()
       * ran, then opened by itself before the click landed — so a working
       * cashier failed the check every day, on every domain.
       *
       * A click that fails is therefore not a verdict. Whatever happened to the
       * click, the final assertion below is the only thing that decides the
       * result, and it passes ONLY if the cashier is actually on screen. A
       * genuinely broken cashier still fails; it just fails on the right line.
       */
      const alreadyOpen = await modal.isVisible().catch(() => false);

      let clickFailure: string | null = null;
      if (!alreadyOpen) {
        const deposit = brand.depositButton(page);
        await expect(
          deposit,
          `${brand.label}: deposit button not found while logged in`,
        ).toBeVisible({ timeout: 30_000 });
        try {
          await deposit.click({ timeout: 10_000 });
        } catch (e) {
          clickFailure = (e as Error).message.split("\n")[0] ?? "click failed";
        }
      }

      await expect(
        modal,
        clickFailure
          ? `${brand.label}: cashier modal did not open (the Deposit click also failed: ${clickFailure})`
          : `${brand.label}: cashier modal did not open`,
      ).toBeVisible({ timeout: 30_000 });
    });
  });
}
