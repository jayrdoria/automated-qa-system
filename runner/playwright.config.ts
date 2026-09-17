import { defineConfig, devices } from "@playwright/test";
import path from "node:path";

// Local dev reads the repo-root .env. In Docker there is no such file — compose
// injects the real values via env_file — so a miss here is expected, not an error.
try {
  process.loadEnvFile(path.resolve(__dirname, "../.env"));
} catch {
  // running in the container, or no .env yet
}

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
  /*
   * Spec files carry numeric prefixes because Playwright orders files
   * alphabetically and there is no ordering API. The order is deliberate and
   * matches the dashboard rows:
   *
   *   1 site-up  -> the canary. If the site is down this fails FIRST, so the
   *                 five failures behind it are read as consequences rather
   *                 than five separate incidents discovered one by one.
   *   2 login    -> everything below needs a session
   *   3..6       -> features, cheapest first
   *
   * Renaming a spec without keeping its prefix will silently reshuffle the run
   * order and the dashboard will look like it is filling in at random.
   */
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
    // Ships results to the dashboard and drives alerting. Last so it sees
    // every result; failures inside it never fail the run.
    ["./reporter/qa-reporter.ts"],
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
      use: {
        ...devices["Desktop Chrome"],
        // devices["Desktop Chrome"] is 1280x720, which puts Stakes into its
        // compact header: the Login button collapses behind an icon and is
        // present in the DOM but not visible. Checks then fail on a hidden
        // element, which reads as "login broken" rather than "wrong viewport".
        // Matches a normal desktop browser.
        viewport: { width: 1920, height: 1080 },
      },
    },
  ],
});
