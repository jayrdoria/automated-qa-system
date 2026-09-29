import { prisma } from "./prisma";
import { getEnv } from "./env";
import { sendAlert, resolveScreenshot, SCREENSHOT_CID } from "./notify";
import { renderAlert, type AlertKind } from "./email";
import { CANARY_CHECK, CHECK_LABELS } from "./checks";
import { groupRun, consequenceReason } from "./incidents";

/**
 * Alert dedup / anti-flapping.
 *
 * Alerts fire on the TRANSITION into failing, once on recovery, and again only
 * after ALERT_RENOTIFY_HOURS if still broken. Without this a 2am breakage sends
 * ~30 emails by morning, the channel gets muted, and the system is worse than
 * having no monitoring at all.
 *
 * Four refinements, each driven by what production actually recorded:
 *
 *  1. TWO STRIKES. A FAILING email waits for a second consecutive failed run
 *     (~20 minutes later). One-off blips — a slow VPN exit, a lost race — pass
 *     on the next run and never reach Slack. Each run already retries a failed
 *     check once, so two strikes means four failed attempts in a row.
 *
 *  2. THE CANARY IS IMMEDIATE. site-up alerts on the first failure: a site that
 *     is down should never wait twenty minutes to be announced.
 *
 *  3. ONE BREAKAGE, ONE ALERT. Checks depend on each other (see incidents.ts):
 *     when the site or its login breaks, everything below it fails in the same
 *     run. One incident in the first fortnight produced 84 red rows that way.
 *     Only the highest failing link is announced, listing what failed because
 *     of it; the rest are still recorded and tracked. When EVERY check in a run
 *     fails, that is treated as down-or-maintenance and announced immediately.
 *
 *  4. BLOCKED IS NOT EVIDENCE. A Cloudflare refusal means the check never
 *     reached the site, so it neither fails nor recovers anything.
 *
 * game-load alert state is kept PER GAME (check key "game-load:multifly"). The
 * check rotates between games, so with a single key one broken game would flap
 * FAILING → RECOVERED → FAILING every hour as the rotation moved past it.
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

/** Consecutive failed runs before a FAILING email. The canary uses 1. */
const FAIL_THRESHOLD = 2;

export function stateKey(r: Pick<IncomingResult, "checkName" | "target">): string {
  return r.target ? `${r.checkName}:${r.target}` : r.checkName;
}

export async function processResults(results: IncomingResult[]): Promise<void> {
  const evidence = results.filter((r) => !r.blocked);

  // Every check blocked at the edge means we never reached the site. One alert
  // about that, not N claiming N features are broken.
  if (results.length > 0 && evidence.length === 0) {
    await handleAllBlocked(results);
    return;
  }

  // A batch is normally one run (one brand + region), but group defensively so
  // a canary in one run can never suppress another run's alerts.
  const runs = new Map<string, IncomingResult[]>();
  for (const r of evidence) {
    const k = `${r.brand}:${r.region}`;
    runs.set(k, [...(runs.get(k) ?? []), r]);
  }

  for (const run of runs.values()) {
    const { incidents, allFailed } = groupRun(
      run.map((r) => ({ checkName: r.checkName, failed: r.status === "fail", r })),
    );
    const handled = new Set<IncomingResult>();

    for (const { root, consequences } of incidents) {
      // The site being down — or everything failing at once, which in practice
      // means maintenance — is announced at once. Anything narrower waits for
      // the two-strike rule.
      const immediate = allFailed || root.checkName === CANARY_CHECK;
      await advance(root.r, {
        immediate,
        allFailed,
        consequences: consequences.map((c) => CHECK_LABELS[c.checkName] ?? c.checkName),
        consequenceReason: consequenceReason(root.checkName, allFailed),
      });
      handled.add(root.r);
      for (const c of consequences) {
        await advance(c.r, { suppress: true });
        handled.add(c.r);
      }
    }

    for (const r of run) if (!handled.has(r)) await advance(r, {});
  }
}

interface AdvanceOptions {
  /** Record the state but announce nothing — a consequence of another failure. */
  suppress?: boolean;
  /** Alert on the first failure rather than waiting for two in a row. */
  immediate?: boolean;
  allFailed?: boolean;
  /** What else failed because of this one, and why. */
  consequences?: string[];
  consequenceReason?: string;
}

async function advance(r: IncomingResult, opts: AdvanceOptions): Promise<void> {
  const checkName = stateKey(r);
  const key = { brand_region_checkName: { brand: r.brand, region: r.region, checkName } };
  const prev = await prisma.checkState.findUnique({ where: key });
  const now = new Date();
  const threshold = opts.immediate || r.checkName === CANARY_CHECK ? 1 : FAIL_THRESHOLD;
  const failKind: AlertKind = opts.immediate || r.checkName === CANARY_CHECK ? "site-down" : "failing";
  const context = {
    consequences: opts.consequences,
    consequenceReason: opts.consequenceReason,
    allFailed: opts.allFailed,
  };

  if (r.status === "pass") {
    if (!prev) {
      await prisma.checkState.create({
        data: { brand: r.brand, region: r.region, checkName, status: "pass", since: now },
      });
      return;
    }
    if (prev.status === "fail") {
      await prisma.checkState.update({
        where: key,
        data: { status: "pass", since: now, failStreak: 0, lastNotifiedAt: null },
      });
      // Only announce a recovery for a failure we announced. A single blip that
      // never crossed the threshold recovers silently — nobody was told about it.
      if (prev.lastNotifiedAt) await notify(r, "recovered", { since: prev.since });
      return;
    }
    await prisma.checkState.update({ where: key, data: { status: "pass", failStreak: 0 } });
    return;
  }

  // ── fail ──
  if (!prev || prev.status === "pass") {
    const alertNow = !opts.suppress && threshold <= 1;
    const data = { status: "fail", since: now, failStreak: 1, lastNotifiedAt: alertNow ? now : null };
    if (prev) await prisma.checkState.update({ where: key, data });
    else await prisma.checkState.create({ data: { brand: r.brand, region: r.region, checkName, ...data } });
    if (alertNow) await notify(r, failKind, { since: now, ...context });
    return;
  }

  // Still failing.
  const streak = prev.failStreak + 1;
  if (opts.suppress) {
    await prisma.checkState.update({ where: key, data: { failStreak: streak } });
    return;
  }

  if (!prev.lastNotifiedAt) {
    // Failing, but not yet announced: announce once the streak reaches the bar.
    const alertNow = streak >= threshold;
    await prisma.checkState.update({
      where: key,
      data: { failStreak: streak, ...(alertNow ? { lastNotifiedAt: now } : {}) },
    });
    if (alertNow) await notify(r, failKind, { since: prev.since, ...context });
    return;
  }

  const hours = Number(getEnv().ALERT_RENOTIFY_HOURS);
  const due = now.getTime() - prev.lastNotifiedAt.getTime() >= hours * 3600_000;
  await prisma.checkState.update({
    where: key,
    data: { failStreak: streak, ...(due ? { lastNotifiedAt: now } : {}) },
  });
  if (due) await notify(r, "still-failing", { since: prev.since });
}

async function notify(
  r: IncomingResult,
  kind: AlertKind,
  extra: {
    since?: Date;
    consequences?: string[];
    consequenceReason?: string;
    allFailed?: boolean;
  },
): Promise<void> {
  // History for this exact check (and game), including the run just ingested.
  const recent = await prisma.checkRun.findMany({
    where: {
      brand: r.brand,
      region: r.region,
      checkName: r.checkName,
      ...(r.target ? { target: r.target } : {}),
    },
    orderBy: { startedAt: "desc" },
    take: 6,
    select: { status: true },
  });

  const screenshotPath = kind === "recovered" ? null : resolveScreenshot(r.screenshot);
  const email = renderAlert({
    kind,
    brand: r.brand,
    region: r.region,
    checkName: r.checkName,
    target: r.target,
    error: r.error,
    startedAt: new Date(r.startedAt),
    since: extra.since,
    recent,
    consequences: extra.consequences,
    consequenceReason: extra.consequenceReason,
    allFailed: extra.allFailed,
    dashboardUrl: DASHBOARD_URL,
    screenshotCid: screenshotPath ? SCREENSHOT_CID : null,
  });
  await sendAlert(email, screenshotPath);
}

/**
 * Edge blocks are deduped on a single synthetic key so repeated runs behave
 * like any other failing check rather than emailing every 20 minutes.
 */
async function handleAllBlocked(results: IncomingResult[]): Promise<void> {
  const key = {
    brand_region_checkName: { brand: "_system", region: "XX", checkName: "edge-access" },
  };
  const prev = await prisma.checkState.findUnique({ where: key });
  const now = new Date();
  const hours = Number(getEnv().ALERT_RENOTIFY_HOURS);

  const shouldNotify =
    !prev ||
    prev.status === "pass" ||
    now.getTime() - (prev.lastNotifiedAt?.getTime() ?? 0) >= hours * 3600_000;

  await prisma.checkState.upsert({
    where: key,
    create: {
      brand: "_system",
      region: "XX",
      checkName: "edge-access",
      status: "fail",
      since: now,
      failStreak: 1,
      lastNotifiedAt: shouldNotify ? now : null,
    },
    update: {
      status: "fail",
      failStreak: { increment: 1 },
      ...(prev?.status === "pass" ? { since: now } : {}),
      ...(shouldNotify ? { lastNotifiedAt: now } : {}),
    },
  });

  if (!shouldNotify) return;

  const first = results[0]!;
  await sendAlert(
    renderAlert({
      kind: "blocked",
      brand: first.brand,
      region: first.region,
      checkName: first.checkName,
      error: first.error,
      startedAt: new Date(first.startedAt),
      blockedCount: results.length,
      dashboardUrl: DASHBOARD_URL,
    }),
  );
}
