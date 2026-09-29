import type {
  FullConfig,
  FullResult,
  Reporter,
  Suite,
  TestCase,
  TestResult,
} from "@playwright/test/reporter";
import path from "node:path";
import fs from "node:fs";
import { getConfig } from "../lib/config";
import { BRAND_IDS, siteForRegion, type BrandId } from "../lib/brands";

/**
 * Is this describe-block title one of our brands?
 *
 * This guard used to be `brand !== "stakes" && brand !== "x7"`, hardcoded in
 * three places. Once specs began describing stakes3 and stakescasino, that
 * check discarded every result BEFORE it was recorded — the run passed, exited
 * 0, and posted nothing, while onEnd logged "no monitored checks ran". A green
 * pipeline monitoring nothing is the worst outcome this system can produce, so
 * the brand list now comes from one place.
 */
function isBrand(title: string): title is BrandId {
  return (BRAND_IDS as string[]).includes(title);
}

/**
 * The single domain this run is testing, derived from CHECK_REGION.
 * Used for the progress row, which is keyed by brand+region.
 */
function currentSite(): BrandId | undefined {
  try {
    return siteForRegion(getConfig().CHECK_REGION);
  } catch {
    return undefined;
  }
}

/**
 * Collects every check result and POSTs them in one batch at the end of the run.
 *
 * One batch, not one request per test: a 10-check run becomes a single HTTP
 * call, and the web side sees the whole run at once so alert transitions are
 * computed against a complete picture rather than trickling in.
 */

/**
 * Written when a whole run was edge-blocked and a retry is available. Lives in
 * artifacts/, which is bind-mounted, so scripts/run-checks.sh sees it on the
 * host at ./artifacts/.edge-blocked. MUST match BLOCKED_MARKER there.
 */
const BLOCKED_MARKER = path.resolve(__dirname, "../artifacts/.edge-blocked");

interface Payload {
  brand: string;
  region: string;
  checkName: string;
  status: "pass" | "fail";
  durationMs: number;
  error: string | null;
  screenshot: string | null;
  startedAt: string;
  blocked: boolean;
  /**
   * What exactly was exercised, when a check covers several things — today the
   * game game-load rotated to. Null for single-target checks. Sent to a web
   * build that predates it, it is silently dropped (zod strips unknown keys).
   */
  target: string | null;
}

export default class QaReporter implements Reporter {
  /**
   * Keyed by brand:checkName, not a flat list. onTestEnd fires once per
   * ATTEMPT, so with retries:1 a flat array records every check twice —
   * doubling run history and skewing the blocked-vs-broken ratio. Overwriting
   * by key means the final attempt wins, which is the outcome that matters.
   */
  private results = new Map<string, Payload>();
  private artifactsRoot = "";
  private monitoredTotal = 0;
  private completed = 0;
  private passed = 0;
  private failed = 0;
  private currentCheck: string | null = null;
  private currentStartedAt: string | null = null;

  /**
   * Fire-and-forget: progress is cosmetic, so a slow or unreachable dashboard
   * must never stall or fail the actual checks.
   */
  private postProgress(done: boolean): void {
    let cfg;
    try {
      cfg = getConfig();
    } catch {
      return;
    }
    if (this.monitoredTotal === 0) return;
    // No column for this region — nothing ran, so there is no progress to report.
    const site = currentSite();
    if (!site) return;
    const url = cfg.INGEST_URL.replace(/\/results$/, "/progress");
    void fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${cfg.INGEST_TOKEN}`,
      },
      body: JSON.stringify({
        brand: site,
        region: cfg.CHECK_REGION,
        total: this.monitoredTotal,
        completed: this.completed,
        passed: this.passed,
        failed: this.failed,
        currentCheck: this.currentCheck,
        currentStartedAt: this.currentStartedAt,
        // Accumulated outcomes so far, so each row can show its verdict the
        // moment it finishes rather than waiting for the end-of-run batch.
        results: Object.fromEntries(
          [...this.results.values()].map((r) => [r.checkName, r.status]),
        ),
        done,
      }),
      signal: AbortSignal.timeout(5_000),
    }).catch(() => {});
  }

  onBegin(config: FullConfig, suite: Suite): void {
    /*
     * Count only checks that will actually REPORT.
     *
     * suite.allTests() includes X7 even when X7_ENABLED=false — those are
     * skipped at runtime, not excluded from the suite. Counting them made the
     * denominator 14 instead of 7, so a fully successful run displayed as
     * "7/14 · 50%" and the bar never filled.
     */
    const site = currentSite();
    const active: string[] = site ? [site] : [];
    this.monitoredTotal = suite
      .allTests()
      .filter(
        (t) =>
          !t.title.startsWith("pipeline smoke") &&
          active.includes(t.parent.title),
      ).length;
    this.postProgress(false);
    // outputDir is where Playwright writes screenshots/traces; we report paths
    // relative to it so the web container can resolve them on the shared mount.
    this.artifactsRoot = config.projects[0]?.outputDir ?? "";
  }

  /** Checks run sequentially (workers: 1), so there is exactly one at a time. */
  onTestBegin(testCase: TestCase): void {
    const brand = testCase.parent.title;
    if (!isBrand(brand)) return;
    if (testCase.title.startsWith("pipeline smoke")) return;
    this.currentCheck = testCase.title;
    this.currentStartedAt = new Date().toISOString();
    this.postProgress(false);
  }

  onTestEnd(testCase: TestCase, result: TestResult): void {
    // describe() block is the brand; test title is the check name.
    const brand = testCase.parent.title;
    const checkName = testCase.title;

    // Skip the deploy-gate smoke test — it isn't a monitored check.
    if (checkName.startsWith("pipeline smoke")) return;
    if (!isBrand(brand)) return;

    // A skipped check produced NO evidence. Reporting it as "fail" (anything
    // not "passed") would post deferred X7 checks as 7 failures every run and
    // permanently redden a dashboard that is working correctly.
    if (result.status === "skipped") return;

    const errorText = result.error?.message ?? null;
    const blocked = errorText?.includes("EDGE_BLOCKED") ?? false;

    const shot = result.attachments.find(
      (a) => a.name === "screenshot" && a.path,
    );

    this.results.set(`${brand}:${checkName}`, {
      brand,
      region: getConfig().CHECK_REGION,
      checkName,
      status: result.status === "passed" ? "pass" : "fail",
      durationMs: result.duration,
      error: errorText ? errorText.slice(0, 4000) : null,
      screenshot:
        shot?.path && this.artifactsRoot
          ? path.relative(this.artifactsRoot, shot.path).replace(/\\/g, "/")
          : null,
      startedAt: result.startTime.toISOString(),
      blocked,
      // The spec pushes this before its first assertion, so it is present on
      // failures too. Read from the RESULT (this attempt), not the test case,
      // so a retry that rotated to a different game can never mislabel.
      target:
        result.annotations.find((a) => a.type === "target")?.description ??
        testCase.annotations.find((a) => a.type === "target")?.description ??
        null,
    });

    this.completed = this.results.size;
    this.passed = [...this.results.values()].filter((r) => r.status === "pass").length;
    this.failed = this.completed - this.passed;
    this.currentCheck = null;
    this.currentStartedAt = null;
    this.postProgress(false);
  }

  async onEnd(result: FullResult): Promise<void> {
    this.currentCheck = null;
    this.currentStartedAt = null;
    this.postProgress(true);
    const payload = [...this.results.values()];
    if (payload.length === 0) {
      console.log("[qa-reporter] no monitored checks ran — nothing to report");
      return;
    }

    const blockedCount = payload.filter((r) => r.blocked).length;
    if (blockedCount === payload.length) {
      /*
       * The whole run was refused by Cloudflare — every check failed before
       * reaching the site. In production that was a flagged VPN exit IP, and a
       * different exit got through. When scripts/run-checks.sh says a retry is
       * available, hold these results back and leave a marker instead: it
       * rotates the tunnel and runs again, and only THAT run is recorded. A run
       * that never reached the site is not worth a row, a red cell or an email.
       *
       * The retry runs with DEFER_IF_BLOCKED unset, so if it is blocked too the
       * results ARE posted — a real, persistent block is never hidden.
       */
      if (process.env.DEFER_IF_BLOCKED === "1") {
        try {
          fs.writeFileSync(BLOCKED_MARKER, new Date().toISOString());
          console.warn(
            `[qa-reporter] ALL ${blockedCount} checks were blocked at the edge — results held ` +
              `back, marker written for a retry through a fresh VPN exit`,
          );
          return;
        } catch (e) {
          // Cannot signal a retry, so fall through and record what we have.
          console.error(`[qa-reporter] could not write retry marker: ${(e as Error).message}`);
        }
      }
      console.warn(
        `[qa-reporter] ALL ${blockedCount} checks hit an edge block. ` +
          `The source IP is almost certainly not whitelisted / outside the ` +
          `permitted region. Reporting as blocked, not as ${blockedCount} broken checks.`,
      );
    }

    let cfg;
    try {
      cfg = getConfig();
    } catch (e) {
      console.error(`[qa-reporter] cannot post results: ${(e as Error).message}`);
      return;
    }

    try {
      const res = await fetch(cfg.INGEST_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${cfg.INGEST_TOKEN}`,
        },
        body: JSON.stringify({ results: payload }),
        signal: AbortSignal.timeout(30_000),
      });

      if (!res.ok) {
        console.error(
          `[qa-reporter] ingest rejected: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`,
        );
        return;
      }
      console.log(
        `[qa-reporter] posted ${payload.length} results (run ${result.status})`,
      );
    } catch (e) {
      // Never fail the run because reporting failed — the checks themselves
      // are the source of truth and the next run will re-report.
      console.error(`[qa-reporter] ingest unreachable: ${(e as Error).message}`);
    }
  }

  printsToStdio(): boolean {
    return false;
  }
}
