import { prisma } from "./prisma";
import { sendAlert, resolveScreenshot, screenshotCid, type InlineImage } from "./notify";
import {
  renderRunAlert,
  renderRecoveryAlert,
  renderBlockedAlert,
  checkLabel,
  byCheckOrder,
  type FailedCheck,
  type RecoveredCheck,
} from "./email";
import { CHECK_LABELS } from "./checks";
import { groupRun } from "./incidents";

/**
 * Turns each ingested run into at most two Slack emails.
 *
 *  1. EVERY FAILING RUN IS ANNOUNCED. A run with any failed check sends one
 *     email listing every failure in it, each marked NEW or STILL FAILING.
 *     Nothing waits for a second strike or a re-notify window: the channel is
 *     how the team knows each run is clean, so a red run on the dashboard
 *     always has exactly one email beside it.
 *
 *  2. ONE RUN, ONE EMAIL. Checks depend on each other (see incidents.ts): when
 *     login breaks, game-load and the cashier fail with it. They are all
 *     listed, in one message, with the dependent ones marked as likely caused
 *     by the check they need. A failed canary, or a run where everything past
 *     the homepage failed, is headlined SITE DOWN.
 *
 *  3. RECOVERY IS ANNOUNCED ONCE. A run in which previously announced
 *     failures pass again sends one RECOVERED email listing them. A clean run
 *     with nothing to recover sends nothing — silence means all good.
 *
 *  4. BLOCKED IS NOT EVIDENCE. A Cloudflare refusal never reached the site,
 *     so it neither fails nor recovers anything. A run blocked entirely sends
 *     a BLOCKED email; a partly blocked run lists those checks as not tested.
 *
 * game-load state is kept PER CHECK, not per game. The games are only a
 * rotation: the verdict is whatever the latest run found, whichever game it
 * tested — a failing run alerts, the next passing run recovers it. (Per-game
 * state kept a column red until that same game came round again; see
 * migration 0009.) The game is still named in every email.
 */

export interface IncomingResult {
  brand: string;
  region: string;
  checkName: string;
  status: "pass" | "fail";
  durationMs: number;
  error?: string | null;
  screenshot?: string | null;
  startedAt: string;
  blocked?: boolean;
  target?: string | null;
}

const DASHBOARD_URL = "https://employee.netovation.eu/automated-qa-system";

/** How many past runs the per-check history line shows. */
const HISTORY_RUNS = 6;

/** One alert state per check — the game a run tested does not split it. */
export function stateKey(r: Pick<IncomingResult, "checkName">): string {
  return r.checkName;
}

export async function processResults(results: IncomingResult[]): Promise<void> {
  // A batch is normally one run (one brand + region), but group defensively so
  // one run's results can never be reported under another's.
  const runs = new Map<string, IncomingResult[]>();
  for (const r of results) {
    const k = `${r.brand}:${r.region}`;
    runs.set(k, [...(runs.get(k) ?? []), r]);
  }
  for (const run of runs.values()) await processRun(run);
}

async function processRun(run: IncomingResult[]): Promise<void> {
  const evidence = run.filter((r) => !r.blocked);

  // Every check blocked at the edge means we never reached the site. One alert
  // about that, not N claiming N features are broken.
  if (evidence.length === 0) {
    await handleAllBlocked(run);
    return;
  }

  const now = new Date();
  const outcomes: Outcome[] = [];
  for (const r of evidence) outcomes.push(await advance(r, now));

  const failed = outcomes.filter((o): o is FailOutcome => o.kind === "new" || o.kind === "still-failing");
  const recovered = outcomes.filter((o): o is RecoveredOutcome => o.kind === "recovered");
  const first = evidence[0]!;

  if (failed.length > 0) {
    const { allFailed, incidents } = groupRun(
      evidence.map((r) => ({ checkName: r.checkName, failed: r.status === "fail", r })),
    );
    // Hints only — nothing is left out of the email. When everything failed
    // the lead already says why, and "caused by" the first check would mislead.
    const causedBy = new Map<IncomingResult, string>();
    if (!allFailed) {
      for (const { root, consequences } of incidents) {
        for (const c of consequences) causedBy.set(c.r, CHECK_LABELS[root.checkName] ?? root.checkName);
      }
    }

    // In the order the email lists them, so attachment 1 is item 1's screenshot.
    const ordered = byCheckOrder(failed.map((o) => ({ ...o, checkName: o.r.checkName })));
    const images: InlineImage[] = [];
    const cids = ordered.map((o) => {
      const shot = resolveScreenshot(o.r.screenshot);
      if (!shot) return null;
      const cid = screenshotCid(images.length);
      images.push({ path: shot, cid });
      return cid;
    });
    const histories = await Promise.all(ordered.map((o) => history(o.r)));
    const failures: FailedCheck[] = ordered.map((o, i) => ({
      checkName: o.r.checkName,
      target: o.r.target,
      error: o.r.error,
      isNew: o.kind === "new",
      since: o.since,
      streak: o.streak,
      recent: histories[i],
      causedBy: causedBy.get(o.r) ?? null,
      screenshotCid: cids[i],
    }));

    await sendAlert(
      renderRunAlert({
        brand: first.brand,
        region: first.region,
        startedAt: new Date(first.startedAt),
        failures,
        total: evidence.length,
        blocked: run.filter((r) => r.blocked).map((r) => checkLabel(r.checkName, r.target)),
        allFailed,
        dashboardUrl: DASHBOARD_URL,
      }),
      images,
    );
  }

  if (recovered.length > 0) {
    const checks: RecoveredCheck[] = await Promise.all(
      recovered.map(async (o) => ({
        checkName: o.r.checkName,
        target: o.r.target,
        since: o.since,
        recent: await history(o.r),
      })),
    );
    await sendAlert(
      renderRecoveryAlert({
        brand: first.brand,
        region: first.region,
        startedAt: new Date(first.startedAt),
        recovered: checks,
        dashboardUrl: DASHBOARD_URL,
      }),
    );
  }
}

type FailOutcome = {
  kind: "new" | "still-failing";
  r: IncomingResult;
  since: Date;
  streak: number;
};
type RecoveredOutcome = { kind: "recovered"; r: IncomingResult; since: Date };
type Outcome = FailOutcome | RecoveredOutcome | { kind: "none" };

/**
 * Moves one check's stored state forward and says what changed. Sends nothing:
 * the run decides what to announce once every check in it has been advanced.
 */
async function advance(r: IncomingResult, now: Date): Promise<Outcome> {
  const checkName = stateKey(r);
  const key = { brand_region_checkName: { brand: r.brand, region: r.region, checkName } };
  const prev = await prisma.checkState.findUnique({ where: key });
  // The run's own start, not ingest time — otherwise "failing since" lands a
  // couple of minutes AFTER "checked at" in the same email.
  const at = new Date(r.startedAt);

  if (r.status === "pass") {
    if (!prev) {
      await prisma.checkState.create({
        data: { brand: r.brand, region: r.region, checkName, status: "pass", since: at },
      });
      return { kind: "none" };
    }
    if (prev.status === "fail") {
      await prisma.checkState.update({
        where: key,
        data: { status: "pass", since: at, failStreak: 0, lastNotifiedAt: null },
      });
      // Only announce a recovery for a failure that was announced. Since every
      // failure is now announced, this only stays quiet for blips held back by
      // the old two-strike rule before this version was deployed.
      return prev.lastNotifiedAt ? { kind: "recovered", r, since: prev.since } : { kind: "none" };
    }
    await prisma.checkState.update({ where: key, data: { status: "pass", failStreak: 0 } });
    return { kind: "none" };
  }

  // ── fail ──
  if (!prev || prev.status !== "fail") {
    const data = { status: "fail", since: at, failStreak: 1, lastNotifiedAt: now };
    if (prev) await prisma.checkState.update({ where: key, data });
    else await prisma.checkState.create({ data: { brand: r.brand, region: r.region, checkName, ...data } });
    return { kind: "new", r, since: at, streak: 1 };
  }

  const streak = prev.failStreak + 1;
  await prisma.checkState.update({ where: key, data: { failStreak: streak, lastNotifiedAt: now } });
  return { kind: "still-failing", r, since: prev.since, streak };
}

/** History for this check (any game), including the run just ingested. */
function history(r: IncomingResult): Promise<{ status: string }[]> {
  return prisma.checkRun.findMany({
    where: {
      brand: r.brand,
      region: r.region,
      checkName: r.checkName,
    },
    orderBy: { startedAt: "desc" },
    take: HISTORY_RUNS,
    select: { status: true },
  });
}

/**
 * Announced every blocked run, like any failure: a blocked run means nobody
 * knows whether the site works, which is exactly what the channel is for. The
 * runner already retries a blocked run once through a fresh VPN exit, so this
 * only fires when that retry was refused too. State is kept for the record.
 */
async function handleAllBlocked(run: IncomingResult[]): Promise<void> {
  const key = {
    brand_region_checkName: { brand: "_system", region: "XX", checkName: "edge-access" },
  };
  const prev = await prisma.checkState.findUnique({ where: key });
  const now = new Date();

  await prisma.checkState.upsert({
    where: key,
    create: {
      brand: "_system",
      region: "XX",
      checkName: "edge-access",
      status: "fail",
      since: now,
      failStreak: 1,
      lastNotifiedAt: now,
    },
    update: {
      status: "fail",
      failStreak: { increment: 1 },
      ...(prev?.status === "pass" ? { since: now } : {}),
      lastNotifiedAt: now,
    },
  });

  const first = run[0]!;
  await sendAlert(
    renderBlockedAlert({
      brand: first.brand,
      region: first.region,
      startedAt: new Date(first.startedAt),
      blockedCount: run.length,
      dashboardUrl: DASHBOARD_URL,
    }),
  );
}
