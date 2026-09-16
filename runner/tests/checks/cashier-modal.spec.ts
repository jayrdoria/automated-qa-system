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

      const deposit = brand.depositButton(page);
      await expect(
        deposit,
        `${brand.label}: deposit button not found while logged in`,
      ).toBeVisible({ timeout: 30_000 });
      await deposit.click();

      await expect(
        brand.cashierModal(page),
        `${brand.label}: cashier modal did not open from deposit`,
      ).toBeVisible({ timeout: 30_000 });
    });
  });
}
