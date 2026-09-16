import { prisma } from "@/lib/prisma";
import { BRANDS, BRAND_LABELS, CHECKS, REGIONS, DEFERRED_BRANDS } from "@/lib/checks";
import { RunStatus } from "./RunStatus";
import { RUN_INTERVAL_MIN } from "@/lib/checks";

// Cron writes new rows every 20 min — never cache this.
export const dynamic = "force-dynamic";

/// A check whose last run is older than this is reported as stale rather than
/// passing. Without it, a dead cron looks identical to everything being green,
/// which is the most dangerous failure mode a monitoring dashboard has.
const STALE_AFTER_MS = 45 * 60 * 1000;

type Status = "pass" | "fail" | "stale" | "none" | "deferred";

function statusOf(lastRun: { status: string; startedAt: Date } | undefined): Status {
  if (!lastRun) return "none";
  if (Date.now() - lastRun.startedAt.getTime() > STALE_AFTER_MS) return "stale";
  return lastRun.status === "pass" ? "pass" : "fail";
}

const STATUS_STYLES: Record<Status, string> = {
  deferred: "border-l-neutral-400 bg-neutral-50/60 dark:bg-neutral-900/40 opacity-70",
  pass: "border-l-[var(--color-pass)] bg-emerald-50/50 dark:bg-emerald-950/20",
  fail: "border-l-[var(--color-fail)] bg-red-50/50 dark:bg-red-950/20",
  stale: "border-l-[var(--color-stale)] bg-amber-50/50 dark:bg-amber-950/20",
  none: "border-l-neutral-300 dark:border-l-neutral-700",
};

/** Compact cell styling for the matrix — colour carries the signal, the word confirms it. */
const CELL_STYLES: Record<Status, string> = {
  pass: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  fail: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
  stale: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  none: "bg-neutral-100 text-neutral-400 dark:bg-neutral-900 dark:text-neutral-600",
  deferred: "bg-neutral-100 text-neutral-400 dark:bg-neutral-900 dark:text-neutral-600",
};

/// Never colour alone — these labels keep the grid readable for colour-blind
/// users and when it is printed or screenshotted into Slack.
const CELL_LABELS: Record<Status, string> = {
  pass: "Pass",
  fail: "Fail",
  stale: "Stale",
  none: "—",
  deferred: "—",
};

const STATUS_LABELS: Record<Status, string> = {
  deferred: "Deferred",
  pass: "Passing",
  fail: "Failing",
  stale: "Stale",
  none: "No data",
};

function PagerLink({
  page,
  disabled,
  label,
}: {
  page: number;
  disabled: boolean;
  label: string;
}) {
  const base = "rounded border px-3 py-1 transition-colors";
  if (disabled) {
    return (
      <span
        className={`${base} cursor-not-allowed border-neutral-200 text-neutral-300 dark:border-neutral-800 dark:text-neutral-700`}
      >
        {label}
      </span>
    );
  }
  return (
    <a
      href={`?page=${page}`}
      className={`${base} border-neutral-300 hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800`}
    >
      {label}
    </a>
  );
}

/**
 * Playwright embeds ANSI colour codes in assertion messages. Rendered raw they
 * appear as [2m[31m noise in the browser and in Slack alerts.
 */
function cleanError(error: string | null | undefined): string | null {
  if (!error) return null;
  return error
    // eslint-disable-next-line no-control-regex
    .replace(/\[[0-9;]*m/g, "")
    .replace(/\[\d+m/g, "")
    .split("\n")[0]!
    .trim()
    .slice(0, 200);
}

function timeAgo(date: Date): string {
  const mins = Math.round((Date.now() - date.getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

const PAGE_SIZE = 25;

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  const pageParam = Number((await searchParams).page ?? "1");
  const page = Number.isFinite(pageParam) && pageParam > 0 ? Math.floor(pageParam) : 1;

  const [latestRuns, recentRuns, totalRuns] = await Promise.all([
    // Postgres DISTINCT ON — one row per brand/check, the newest.
    prisma.$queryRaw<
      {
        brand: string;
        region: string;
        check_name: string;
        status: string;
        started_at: Date;
        duration_ms: number;
        error: string | null;
      }[]
    >`
      SELECT DISTINCT ON (brand, region, check_name)
        brand, region, check_name, status, started_at, duration_ms, error
      FROM check_run
      ORDER BY brand, region, check_name, started_at DESC
    `,
    prisma.checkRun.findMany({
      orderBy: { startedAt: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    }),
    prisma.checkRun.count(),
  ]);

  const totalPages = Math.max(1, Math.ceil(totalRuns / PAGE_SIZE));

  const byKey = new Map(
    latestRuns.map((r) => [
      `${r.brand}:${r.region}:${r.check_name}`,
      {
        status: r.status,
        startedAt: r.started_at,
        durationMs: r.duration_ms,
        error: r.error,
      },
    ]),
  );

  // Most recent result per region — feeds the live schedule indicator so it can
  // tell "a tick passed and nothing arrived" (running, or late) from "we have
  // fresh data" (idle, counting down).
  const lastRunByRegion = new Map<string, string>();
  for (const r of latestRuns) {
    const prev = lastRunByRegion.get(r.region);
    if (!prev || new Date(prev) < r.started_at) {
      lastRunByRegion.set(r.region, r.started_at.toISOString());
    }
  }

  // ALL four markets are always rendered, including ones with no data yet.
  // Hiding empty regions would make "we never ran DE" look identical to "DE
  // isn't monitored" — the operator needs to see the full coverage grid and
  // spot a region that has silently stopped reporting.
  const shownRegions = REGIONS;

  // Surfaced above the matrix so a failure is readable at a glance — the grid
  // says WHICH cell is red, this says WHY, without a click.
  const currentFailures = BRANDS.filter((b) => !DEFERRED_BRANDS.includes(b)).flatMap((b) =>
    shownRegions.flatMap((rg) =>
      CHECKS.flatMap((c) => {
        const last = byKey.get(`${b}:${rg.id}:${c.id}`);
        if (statusOf(last) !== "fail") return [];
        return [{
          key: `${b}:${rg.id}:${c.id}`,
          brand: BRAND_LABELS[b],
          region: rg.id,
          check: c.label,
          error: cleanError(last?.error),
        }];
      }),
    ),
  );

  const failing = BRANDS.filter((b) => !DEFERRED_BRANDS.includes(b)).flatMap((b) =>
    shownRegions.flatMap((rg) =>
      CHECKS.map((c) => statusOf(byKey.get(`${b}:${rg.id}:${c.id}`))),
    ),
  ).filter((s) => s === "fail").length;

  return (
    <main className="mx-auto max-w-6xl px-6 py-10">
      <header className="mb-8 flex flex-wrap items-baseline justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            Automated QA Monitor
          </h1>
          <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
            Stakes.com &amp; X7 Casino · {shownRegions.map((r) => r.id).join(" · ")}{" "}
            · each market checked every {RUN_INTERVAL_MIN} minutes
          </p>
        </div>
        <span
          className={`rounded-full px-3 py-1 text-sm font-medium ${
            failing > 0
              ? "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-200"
              : "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200"
          }`}
        >
          {failing > 0 ? `${failing} failing` : "All green"}
        </span>
      </header>

      {currentFailures.length > 0 && (
        <section className="mb-8 rounded-lg border border-red-200 bg-red-50/50 p-4 dark:border-red-900 dark:bg-red-950/20">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-red-800 dark:text-red-300">
            Current failures
          </h2>
          <ul className="space-y-2">
            {currentFailures.map((f) => (
              <li key={f.key} className="text-sm">
                <span className="font-medium">
                  {f.brand} · {f.region} · {f.check}
                </span>
                <p className="mt-0.5 break-words font-mono text-xs text-neutral-600 dark:text-neutral-400">
                  {f.error ?? "(no error captured)"}
                </p>
              </li>
            ))}
          </ul>
        </section>
      )}

      {BRANDS.map((brand) => {
        const deferred = DEFERRED_BRANDS.includes(brand);
        return (
          <section key={brand} className="mb-10">
            <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
              {BRAND_LABELS[brand]}
              {deferred && (
                <span className="rounded bg-neutral-200 px-2 py-0.5 text-[11px] font-medium normal-case tracking-normal text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400">
                  deferred — Cloudflare challenge
                </span>
              )}
            </h2>

            {/* Matrix: one row per check, one column per market. Repeating the
                full grid per region made four near-identical blocks and buried
                the one cell that differs. */}
            <div className="overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="bg-neutral-50 dark:bg-neutral-900">
                    <th className="px-4 py-2 text-left font-medium">Check</th>
                    {shownRegions.map((r) => (
                      <th
                        key={r.id}
                        className="px-3 py-2 text-center font-medium"
                        title={r.label}
                      >
                        <div className="flex flex-col items-center leading-tight">
                          <span>{r.id}</span>
                          {!deferred && (
                            <RunStatus
                              cronOffset={r.cronOffset}
                              lastRunIso={lastRunByRegion.get(r.id) ?? null}
                            />
                          )}
                        </div>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {CHECKS.map((check) => (
                    <tr
                      key={check.id}
                      className="border-t border-neutral-200 dark:border-neutral-800"
                    >
                      <td className="px-4 py-2 font-medium">{check.label}</td>
                      {shownRegions.map((region) => {
                        const last = byKey.get(
                          `${brand}:${region.id}:${check.id}`,
                        );
                        const status: Status = deferred
                          ? "deferred"
                          : statusOf(last);
                        return (
                          <td key={region.id} className="px-3 py-2 text-center">
                            <span
                              title={
                                last
                                  ? [
                                      `${STATUS_LABELS[status]} · ${timeAgo(last.startedAt)} · ${(last.durationMs / 1000).toFixed(1)}s`,
                                      cleanError(last.error),
                                    ]
                                      .filter(Boolean)
                                      .join("\n")
                                  : STATUS_LABELS[status]
                              }
                              className={`inline-flex min-w-[64px] items-center justify-center rounded px-2 py-1 text-xs font-medium ${CELL_STYLES[status]}`}
                            >
                              {CELL_LABELS[status]}
                            </span>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        );
      })}

      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
          Recent runs
          <span className="ml-2 font-normal normal-case tracking-normal text-neutral-400">
            {totalRuns.toLocaleString()} total
          </span>
        </h2>
        {recentRuns.length === 0 ? (
          <p className="rounded-lg border border-dashed border-neutral-300 p-8 text-center text-sm text-neutral-500 dark:border-neutral-700">
            No check results yet. The dashboard populates once the cron runner
            posts its first results.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
            <table className="w-full text-sm">
              <thead className="bg-neutral-50 text-left dark:bg-neutral-900">
                <tr>
                  <th className="px-4 py-2 font-medium">When</th>
                  <th className="px-4 py-2 font-medium">Brand</th>
                  <th className="px-4 py-2 font-medium">Region</th>
                  <th className="px-4 py-2 font-medium">Check</th>
                  <th className="px-4 py-2 font-medium">Status</th>
                  <th className="px-4 py-2 font-medium">Took</th>
                  <th className="px-4 py-2 font-medium">Error</th>
                </tr>
              </thead>
              <tbody>
                {recentRuns.map((run) => (
                  <tr
                    key={run.id}
                    className="border-t border-neutral-200 dark:border-neutral-800"
                  >
                    <td className="whitespace-nowrap px-4 py-2 text-neutral-500">
                      {timeAgo(run.startedAt)}
                    </td>
                    <td className="px-4 py-2">{run.brand}</td>
                    <td className="px-4 py-2 text-neutral-500">{run.region}</td>
                    <td className="px-4 py-2">{run.checkName}</td>
                    <td className="px-4 py-2">
                      <span
                        className={
                          run.status === "pass"
                            ? "text-emerald-600 dark:text-emerald-400"
                            : "text-red-600 dark:text-red-400"
                        }
                      >
                        {run.status}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-4 py-2 text-neutral-500">
                      {(run.durationMs / 1000).toFixed(1)}s
                    </td>
                    <td className="max-w-md truncate px-4 py-2 text-neutral-500">
                      {run.error ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {totalRuns > PAGE_SIZE && (
          <nav className="mt-4 flex items-center justify-between text-sm">
            <span className="text-neutral-500">
              Page {page} of {totalPages}
            </span>
            <span className="flex gap-2">
              <PagerLink page={page - 1} disabled={page <= 1} label="← Newer" />
              <PagerLink
                page={page + 1}
                disabled={page >= totalPages}
                label="Older →"
              />
            </span>
          </nav>
        )}
      </section>
    </main>
  );
}
