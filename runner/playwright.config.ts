import { defineConfig, devices } from "@playwright/test";

/**
 * Batch monitoring config — this is not a CI suite, it's a cron-driven prober.
 *
 * workers: 1 / fullyParallel: false  — never hit both brands at once from one IP;
 *   the whole point is to look like ordinary traffic to Cloudflare bot management.
 * retries: 1 + trace on-first-retry  — one immediate retry before a failure counts.
 *   Biggest false-positive reducer available and it costs almost nothing.
 */
export default defineConfig({
  testDir: "./tests",
  outputDir: "./artifacts/test-results",

  fullyParallel: false,
  workers: 1,
  retries: 1,
  forbidOnly: !!process.env.CI,

  timeout: 60_000,
  expect: { timeout: 15_000 },

  reporter: [
    ["list"],
    ["json", { outputFile: "./artifacts/report.json" }],
    ["html", { outputFolder: "./artifacts/html-report", open: "never" }],
  ],

  use: {
    headless: true,
    screenshot: "only-on-failure",
    trace: "on-first-retry",
    video: "off",
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },

  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
