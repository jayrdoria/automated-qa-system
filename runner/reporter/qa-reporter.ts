import type {
  FullConfig,
  FullResult,
  Reporter,
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

  onBegin(config: FullConfig): void {
    // outputDir is where Playwright writes screenshots/traces; we report paths
    // relative to it so the web container can resolve them on the shared mount.
    this.artifactsRoot = config.projects[0]?.outputDir ?? "";
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
  }

  async onEnd(result: FullResult): Promise<void> {
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
