import { test, expect } from "@playwright/test";

/**
 * Phase 6 deploy gate. Deliberately does NOT touch Stakes or X7 — those aren't
 * Cloudflare-whitelisted yet and we don't want bot challenges muddying the signal
 * on whether the *pipeline* works.
 *
 * What it proves on the VPS: the image pulled, Chromium launches under pwuser,
 * /dev/shm is sized right, DNS and outbound TLS work, and the reporter can write
 * to the mounted artifacts volume.
 *
 * Delete or demote this once Phase 2's real checks are green.
 */
test("pipeline smoke: chromium launches and can reach the internet", async ({
  page,
}) => {
  const response = await page.goto("https://example.com", {
    waitUntil: "domcontentloaded",
  });

  expect(response?.ok(), "example.com should return 2xx").toBe(true);
  await expect(page.locator("h1")).toHaveText("Example Domain");
});
