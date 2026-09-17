import type {
  FullConfig,
  FullResult,
  Reporter,
  Suite,
  TestCase,
  TestResult,
} from "@playwright/test/reporter";
import path from "node:path";
import { getConfig } from "../lib/config";

/**
 * Collects every check result and POSTs them in one batch at the end of the run.
 *
 * One batch, not one request per test: a 10-check run becomes a single HTTP
 * call, and the web side sees the whole run at once so alert transitions are
 * computed against a complete picture rather than trickling in.
 */

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
    const url = cfg.INGEST_URL.replace(/\/results$/, "/progress");
    void fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${cfg.INGEST_TOKEN}`,
      },
      body: JSON.stringify({
        brand: "stakes",
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
    let active: string[] = ["stakes"];
    try {
      active = getConfig().X7_ENABLED ? ["stakes", "x7"] : ["stakes"];
    } catch {
      // config unavailable — fall back to the non-deferred brand
    }
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
    if (brand !== "stakes" && brand !== "x7") return;
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
    if (brand !== "stakes" && brand !== "x7") return;

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
