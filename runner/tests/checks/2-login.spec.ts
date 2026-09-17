import { test, expect } from "@playwright/test";
import { BRAND_IDS, activeBrands, getBrand } from "../../lib/brands";
import { login, loginAndVerify } from "../../lib/login";

// X7 skipped while it is Cloudflare-blocked — see activeBrands().
for (const id of BRAND_IDS) {
  const enabled = () => activeBrands().includes(id);
  test.describe(id, () => {
    test.skip(() => !enabled(), "brand deferred (X7_ENABLED=false)");
    test("login", async ({ page }) => {
      await loginAndVerify(page, getBrand(id));
    });

    // Guards against the site "succeeding" on anything — a broken auth layer
    // that accepts garbage is worse than one that rejects valid users.
    test("login-rejects-bad-creds", async ({ page }) => {
      const brand = getBrand(id);
      await login(page, brand, {
        username: brand.username,
        password: "definitely-not-the-password-9F3k2",
      });

      await expect(
        brand.loggedInMarker(page),
        `${brand.label}: bad credentials produced a logged-in session`,
      ).toBeHidden({ timeout: 15_000 });
    });
  });
}
