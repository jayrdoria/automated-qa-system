import { prisma } from "./prisma";
import { getEnv } from "./env";
import { sendAlert } from "./notify";

/**
 * Alert dedup / anti-flapping.
 *
 * Alerts fire on the TRANSITION into failing, once on recovery, and again only
 * after ALERT_RENOTIFY_HOURS if still broken. Without this a 2am breakage sends
 * ~30 emails by morning, the channel gets muted, and the system is worse than
 * having no monitoring at all.
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
}

const DASHBOARD_URL =
  "https://employee.netovation.eu/automated-qa-system";

export async function processResults(results: IncomingResult[]): Promise<void> {
  // Every check blocked at the edge means we never reached the sites. Emit one
  // alert about that, not N alerts claiming N features are broken.
  const blocked = results.filter((r) => r.blocked);
  if (blocked.length > 0 && blocked.length === results.length) {
    await handleAllBlocked(results.length);
    return;
  }

  for (const r of results) {
    await handleOne(r);
  }
}

async function handleOne(r: IncomingResult): Promise<void> {
  // Keyed by region too: FR passing while DE fails are different incidents and
  // must not overwrite each other's alert state.
  const key = {
    brand_region_checkName: { brand: r.brand, region: r.region, checkName: r.checkName },
  };
  const prev = await prisma.checkState.findUnique({ where: key });
  const now = new Date();

  // First time we have ever seen this check.
  if (!prev) {
    await prisma.checkState.create({
      data: {
        brand: r.brand,
        region: r.region,
        checkName: r.checkName,
        status: r.status,
        since: now,
        lastNotifiedAt: r.status === "fail" ? now : null,
      },
    });
    if (r.status === "fail") await notifyFailure(r, "new");
    return;
  }

  // pass → fail : the transition that matters
  if (prev.status === "pass" && r.status === "fail") {
    await prisma.checkState.update({
      where: key,
      data: { status: "fail", since: now, lastNotifiedAt: now },
    });
    await notifyFailure(r, "new");
    return;
  }

  // fail → pass : one recovery notice, then silence
  if (prev.status === "fail" && r.status === "pass") {
    const downMs = now.getTime() - prev.since.getTime();
    await prisma.checkState.update({
      where: key,
      data: { status: "pass", since: now, lastNotifiedAt: null },
    });
    await sendAlert({
      subject: `[RECOVERED] ${r.brand} · ${r.region} · ${r.checkName}`,
      lines: [
        `${r.checkName} on ${r.brand} is passing again.`,
        `Was failing for ${formatDuration(downMs)}.`,
        ``,
        DASHBOARD_URL,
      ],
    });
    return;
  }

  // Still failing — re-notify only after the quiet period.
  if (prev.status === "fail" && r.status === "fail") {
    const hours = Number(getEnv().ALERT_RENOTIFY_HOURS);
    const last = prev.lastNotifiedAt?.getTime() ?? 0;
    if (now.getTime() - last >= hours * 3600_000) {
      await prisma.checkState.update({ where: key, data: { lastNotifiedAt: now } });
      await notifyFailure(r, "still");
    }
    return;
  }

  // pass → pass : nothing to do beyond keeping the row warm.
  await prisma.checkState.update({ where: key, data: { status: "pass" } });
}

async function notifyFailure(r: IncomingResult, kind: "new" | "still"): Promise<void> {
  await sendAlert({
    subject: `${kind === "new" ? "[FAILING]" : "[STILL FAILING]"} ${r.brand} · ${r.region} · ${r.checkName}`,
    lines: [
      `Check : ${r.checkName}`,
      `Brand : ${r.brand}`,
      `Region: ${r.region}`,
      `When  : ${new Date(r.startedAt).toISOString()}`,
      `Took  : ${(r.durationMs / 1000).toFixed(1)}s`,
      ``,
      `Error:`,
      r.error ?? "(no error message captured)",
      ``,
      DASHBOARD_URL,
    ],
    screenshot: r.screenshot,
  });
}

/**
 * Edge blocks are deduped on a single synthetic key so repeated runs behave
 * like any other failing check rather than emailing every 20 minutes.
 */
async function handleAllBlocked(total: number): Promise<void> {
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
      lastNotifiedAt: shouldNotify ? now : null,
    },
    update: {
      status: "fail",
      ...(prev?.status === "pass" ? { since: now } : {}),
      ...(shouldNotify ? { lastNotifiedAt: now } : {}),
    },
  });

  if (!shouldNotify) return;

  await sendAlert({
    subject: `[BLOCKED] QA checks cannot reach the brands`,
    lines: [
      `All ${total} checks were blocked at the CDN edge — the requests never`,
      `reached the applications, so this is NOT ${total} broken features.`,
      ``,
      `Most likely cause: the server IP (194.233.89.28, Singapore) is not`,
      `whitelisted, or is outside the permitted region for these brands.`,
      ``,
      `Check: Cloudflare whitelist status, or the VPN exit node if enabled.`,
      ``,
      DASHBOARD_URL,
    ],
  });
}

function formatDuration(ms: number): string {
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  return `${hours}h ${mins % 60}m`;
}
