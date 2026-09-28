import { prisma } from "@/lib/prisma";
import {
  BRAND_LABELS,
  SITE_DOMAINS,
  CHECKS,
  COLUMNS,
  DEFERRED_BRANDS,
  RUN_INTERVAL_MIN,
  RUN_GRACE_MIN,
  STALE_AFTER_MIN,
} from "@/lib/checks";
import { RunStatus } from "./RunStatus";
import { AutoRefresh } from "./AutoRefresh";
import { RunningCell } from "./RunningCell";

// Cron writes new rows every 20 min — never cache this.
export const dynamic = "force-dynamic";

/// Defined in lib/checks.ts because it is a function of RUN_INTERVAL_MIN and
/// the number of columns contending for the global run lock — not a property
/// of the page.
const STALE_AFTER_MS = STALE_AFTER_MIN * 60 * 1000;

type Status =
  | "pass"
  | "fail"
  | "stale"
  | "none"
  | "deferred"
  | "running"   // this exact check is executing right now
  | "queued";   // in this run, not reached yet

function statusOf(lastRun: { status: string; startedAt: Date } | undefined): Status {
  if (!lastRun) return "none";
  if (Date.now() - lastRun.startedAt.getTime() > STALE_AFTER_MS) return "stale";
  return lastRun.status === "pass" ? "pass" : "fail";
}

const STATUS_STYLES: Record<Status, string> = {
  running: "border-l-sky-500 bg-sky-50/50 dark:bg-sky-950/20",
  queued: "border-l-neutral-300 dark:border-l-neutral-700",
  deferred: "border-l-neutral-400 bg-neutral-50/60 dark:bg-neutral-900/40 opacity-70",
  pass: "border-l-[var(--color-pass)] bg-emerald-50/50 dark:bg-emerald-950/20",
  fail: "border-l-[var(--color-fail)] bg-red-50/50 dark:bg-red-950/20",
  stale: "border-l-[var(--color-stale)] bg-amber-50/50 dark:bg-amber-950/20",
  none: "border-l-neutral-300 dark:border-l-neutral-700",
};

/** Compact cell styling for the matrix — colour carries the signal, the word confirms it. */
const CELL_STYLES: Record<Status, string> = {
  running:
    "bg-sky-500 text-white dark:bg-sky-500 dark:text-white font-medium animate-pulse",
  queued:
    "bg-neutral-100 text-neutral-400 dark:bg-neutral-900 dark:text-neutral-600",
  pass: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  fail: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
  stale: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  none: "bg-neutral-100 text-neutral-400 dark:bg-neutral-900 dark:text-neutral-600",
  deferred: "bg-neutral-100 text-neutral-400 dark:bg-neutral-900 dark:text-neutral-600",
};

/// Never colour alone — these labels keep the grid readable for colour-blind
/// users and when it is printed or screenshotted into Slack.
const CELL_LABELS: Record<Status, string> = {
  running: "Running",
  queued: "Queued",
  pass: "Pass",
  fail: "Fail",
  stale: "Stale",
  none: "—",
  deferred: "—",
};

const STATUS_LABELS: Record<Status, string> = {
  running: "Running now",
  queued: "Waiting in this run",
  deferred: "Deferred",
  pass: "Passing",
  fail: "Failing",
  stale: "Stale",
  none: "No data",
};

/**
 * Numbered pager with ellipsis. Shows first, last, and a window around the
 * current page so the control stays a fixed width at 2 pages or 2000.
 */
function pageNumbers(current: number, total: number): (number | "gap")[] {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const out: (number | "gap")[] = [1];
  const from = Math.max(2, current - 1);
  const to = Math.min(total - 1, current + 1);
  if (from > 2) out.push("gap");
  for (let i = from; i <= to; i++) out.push(i);
  if (to < total - 1) out.push("gap");
  out.push(total);
  return out;
}

function Pager({
  page,
  totalPages,
  status,
}: {
  page: number;
  totalPages: number;
  status: string | null;
}) {
  const href = (p: number) =>
    `?page=${p}${status ? `&status=${status}` : ""}`;
  const box =
    "inline-flex h-8 min-w-8 items-center justify-center rounded border px-2 text-xs transition-colors";
  const idle =
    "border-neutral-300 hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800";
  const off =
    "cursor-not-allowed border-neutral-200 text-neutral-300 dark:border-neutral-800 dark:text-neutral-700";

  return (
    <nav className="mt-4 flex flex-wrap items-center gap-1">
      {page <= 1 ? (
        <span className={`${box} ${off}`}>‹</span>
      ) : (
        <a href={href(page - 1)} className={`${box} ${idle}`}>‹</a>
      )}

      {pageNumbers(page, totalPages).map((n, i) =>
        n === "gap" ? (
          <span key={`gap${i}`} className="px-1 text-xs text-neutral-400">…</span>
        ) : n === page ? (
          <span
            key={n}
            aria-current="page"
            className={`${box} border-neutral-900 bg-neutral-900 font-medium text-white dark:border-neutral-100 dark:bg-neutral-100 dark:text-neutral-900`}
          >
            {n}
          </span>
        ) : (
          <a key={n} href={href(n)} className={`${box} ${idle}`}>
            {n}
          </a>
        ),
      )}

      {page >= totalPages ? (
        <span className={`${box} ${off}`}>›</span>
      ) : (
        <a href={href(page + 1)} className={`${box} ${idle}`}>›</a>
      )}
    </nav>
  );
}

function FilterTabs({ status }: { status: string | null }) {
  const tabs = [
    { key: null, label: "All" },
    { key: "fail", label: "Failures only" },
    { key: "pass", label: "Passes only" },
  ] as const;
  return (
    <div className="flex gap-1">
      {tabs.map((t) => {
        const active = status === t.key;
        // Always reset to page 1 — page 7 of "all" is rarely page 7 of "failures".
        const href = t.key ? `?status=${t.key}` : "?";
        return (
          <a
            key={t.label}
            href={href}
            className={`rounded px-2 py-1 text-xs transition-colors ${
              active
                ? "bg-neutral-900 font-medium text-white dark:bg-neutral-100 dark:text-neutral-900"
                : "text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800"
            }`}
          >
            {t.label}
          </a>
        );
      })}
    </div>
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
  searchParams: Promise<{ page?: string; status?: string }>;
}) {
  const sp = await searchParams;
  const pageParam = Number(sp.page ?? "1");
  const page = Number.isFinite(pageParam) && pageParam > 0 ? Math.floor(pageParam) : 1;
  const statusFilter = sp.status === "fail" || sp.status === "pass" ? sp.status : null;
  const where = statusFilter ? { status: statusFilter } : {};

  const [latestRuns, recentRuns, totalRuns, progressRows, medianRows] =
    await Promise.all([
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
      where,
      orderBy: { startedAt: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    }),
    prisma.checkRun.count({ where }),
    prisma.runProgress.findMany(),
    // Median (p50) duration per check from real history — the denominator for
    // the live progress bar. Median not mean: one 60s timeout would drag an
    // average enough to make every subsequent run look fast.
    prisma.$queryRaw<{ check_name: string; median_ms: number }[]>`
      SELECT check_name,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms)::int AS median_ms
      FROM check_run
      WHERE status = 'pass' AND started_at > now() - interval '7 days'
      GROUP BY check_name
    `,
  ]);

  const medianByCheck = new Map(
    medianRows.map((m) => [m.check_name, Number(m.median_ms)]),
  );

  // A run is "live" only if it is unfinished AND recent. Without the staleness
  // guard, a runner killed mid-run would leave the dashboard claiming a run is
  // in progress forever.
  // Completion times for every region, live or not — the countdown measures
  // from the end of the last run, matching scripts/run-checks.sh.
  const lastFinishedByRegion = new Map(
    progressRows
      .filter((p) => p.finishedAt !== null)
      .map((p) => [p.region, p.finishedAt!.toISOString()]),
  );

  /*
   * A run counts as live only if all three hold:
   *   - it has not reported finishing
   *   - it started recently (a killed runner must not strand the UI)
   *   - check_run does NOT already hold a full set of results newer than it
   *
   * That last one is the self-heal. The "done" ping is fire-and-forget, so a
   * dropped packet used to leave the header frozen at "3/7 running" while the
   * end-of-run batch wrote all seven results underneath — a header contradicting
   * its own rows. If every check has a fresh result, the run is over whatever
   * the ping said.
   */
  /*
   * Takes the brand explicitly. It used to hardcode `x.brand === "stakes"`,
   * which meant that once FR and IT moved to stakes3 no result ever matched,
   * the run never looked complete, and those headers stayed pinned at
   * "n/7 running" forever.
   */
  const fullResultsSince = (brand: string, region: string, since: Date) =>
    CHECKS.every((c) => {
      const r = latestRuns.find(
        (x) => x.region === region && x.check_name === c.id && x.brand === brand,
      );
      return r !== undefined && r.started_at >= since;
    });

  const progressByRegion = new Map(
    progressRows
      .filter(
        (p) =>
          p.finishedAt === null &&
          Date.now() - p.startedAt.getTime() < RUN_GRACE_MIN * 60_000 &&
          !fullResultsSince(p.brand, p.region, p.startedAt),
      )
      .map((p) => [
        p.region,
        {
          completed: p.completed,
          total: p.total,
          startedAt: p.startedAt,
          currentCheck: p.currentCheck,
          currentStartedAt: p.currentStartedAt,
          results: (p.results ?? {}) as Record<string, "pass" | "fail">,
        },
      ]),
  );

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

  // EVERY column is always rendered, including ones with no data yet. Hiding
  // empty columns would make "we never ran DE" look identical to "DE isn't
  // monitored" — the operator needs the full coverage grid to spot a column
  // that has silently stopped reporting.
  const shownColumns = COLUMNS;

  // Surfaced above the matrix so a failure is readable at a glance — the grid
  // says WHICH cell is red, this says WHY, without a click.
  const currentFailures = shownColumns.flatMap((col) =>
    CHECKS.flatMap((c) => {
      const last = byKey.get(`${col.site}:${col.region}:${c.id}`);
      // A column mid-run has no current verdict — excluded so the failures
      // panel doesn't flash last cycle's errors while they are being retested.
      if (progressByRegion.has(col.region)) return [];
      if (statusOf(last) !== "fail") return [];
      return [
        {
          key: `${col.site}:${col.region}:${c.id}`,
          brand: BRAND_LABELS[col.site],
          region: col.region,
          check: c.label,
          error: cleanError(last?.error),
        },
      ];
    }),
  );

  const failing = shownColumns
    .filter((col) => !progressByRegion.has(col.region))
    .flatMap((col) =>
      CHECKS.map((c) =>
        statusOf(byKey.get(`${col.site}:${col.region}:${c.id}`)),
      ),
    )
    .filter((s) => s === "fail").length;

  return (
    <main className="mx-auto max-w-6xl px-6 py-10">
      <AutoRefresh live={progressByRegion.size > 0} />
      <header className="mb-8 flex flex-wrap items-baseline justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            Automated QA Monitor
          </h1>
          <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
            {shownColumns.map((c) => c.region).join(" · ")} · each column checked
            every {RUN_INTERVAL_MIN} minutes
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

          <section className="mb-10">
            {/* One matrix for everything. Each column is a (market, domain)
                pair, because a market is served by exactly one mirror — so
                the domain belongs in the header, not in a separate table per
                brand. Splitting by brand would put FR and DE in different
                blocks and hide the one cell that differs. */}
            <div className="overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="bg-neutral-50 dark:bg-neutral-900">
                    <th className="px-4 py-2 text-left font-medium">Check</th>
                    {shownColumns.map((col) => (
                      <th
                        key={col.region}
                        className="px-3 py-2 text-center font-medium"
                        title={`${col.label} · ${SITE_DOMAINS[col.site]}`}
                      >
                        <div className="flex flex-col items-center leading-tight">
                          <span>{col.region}</span>
                          {/* The whole point of the mirror split: without this
                              you cannot tell which host a green cell refers to. */}
                          <span className="text-[10px] font-normal text-neutral-400 dark:text-neutral-500">
                            {SITE_DOMAINS[col.site]}
                          </span>
                          {(() => {
                            const live = progressByRegion.get(col.region);
                            if (!live) {
                              return (
                                <RunStatus
                                  cronOffset={col.cronOffset}
                                  lastFinishedIso={
                                    lastFinishedByRegion.get(col.region) ?? null
                                  }
                                  lastRunIso={
                                    lastRunByRegion.get(col.region) ?? null
                                  }
                                />
                              );
                            }
                            const pct = Math.round(
                              (live.completed / live.total) * 100,
                            );
                            return (
                              <span className="flex flex-col items-center gap-0.5">
                                <span className="text-[11px] font-medium tabular-nums text-sky-600 dark:text-sky-400">
                                  {live.completed}/{live.total} · {pct}%
                                </span>
                                <span className="h-1 w-12 overflow-hidden rounded-full bg-neutral-200 dark:bg-neutral-800">
                                  <span
                                    className="block h-full rounded-full bg-sky-500 transition-all"
                                    style={{ width: `${pct}%` }}
                                  />
                                </span>
                              </span>
                            );
                          })()}
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
                      {shownColumns.map((region) => {
                        const last = byKey.get(
                          `${region.site}:${region.region}:${check.id}`,
                        );
                        const live = progressByRegion.get(region.region);
                        /*
                         * While a region is mid-run, any result older than that
                         * run's start is last cycle's answer. Showing it as a
                         * confident green is the lie worth avoiding: the point
                         * of re-checking is that the old result is no longer
                         * evidence. Checks already re-run this cycle show their
                         * fresh result immediately.
                         */
                        /*
                         * Three states during a live run, so the grid reads as
                         * a queue draining rather than one aggregate number:
                         *   running — this check is executing now
                         *   queued  — in this run, not reached yet
                         *   pass/fail — already re-run this cycle, fresh result
                         *
                         * A result older than the run start is last cycle's
                         * answer; showing it as confident green is the lie
                         * worth avoiding, since re-checking means it is no
                         * longer evidence.
                         */
                        /*
                         * Row lifecycle during a live run, resolved in order:
                         *   1. this check is executing      -> running
                         *   2. it finished in THIS run      -> pass/fail now
                         *   3. it is in this run, not reached -> queued
                         *   4. no run in flight             -> last known result
                         *
                         * Step 2 is why progress carries per-check outcomes.
                         * check_run is only written as one batch at the end, so
                         * without it a finished check has nowhere to report from
                         * and would sit on "Queued" until the whole column
                         * flipped to Pass at once.
                         */
                        const liveResult = live?.results?.[check.id];
                        const notYetRerun =
                          live !== undefined &&
                          (!last || last.startedAt < live.startedAt);
                        // No "deferred" branch here: every column in COLUMNS is
                        // actively monitored. X7 is the only deferred brand and
                        // it has no column — it renders in its own section below.
                        const status: Status =
                          live && live.currentCheck === check.id
                            ? "running"
                            : liveResult
                              ? liveResult
                              : notYetRerun
                                ? "queued"
                                : statusOf(last);
                        return (
                          <td
                            key={region.region}
                            className="px-3 py-2 text-center"
                          >
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
                              {status === "running" ? (
                                <RunningCell
                                  startedAtIso={
                                    live?.currentStartedAt?.toISOString() ?? null
                                  }
                                  medianMs={medianByCheck.get(check.id) ?? null}
                                />
                              ) : (
                                CELL_LABELS[status]
                              )}
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

          {/* X7 has no column — it is a different operator, still behind a
              Cloudflare interactive challenge that a VPN cannot clear. Shown
              as deferred rather than omitted, so "not monitored" never reads
              as "monitored and healthy". */}
          {DEFERRED_BRANDS.map((brand) => (
            <section key={brand} className="mb-10">
              <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
                {BRAND_LABELS[brand as keyof typeof BRAND_LABELS] ?? brand}
                <span className="rounded bg-neutral-200 px-2 py-0.5 text-[11px] font-medium normal-case tracking-normal text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400">
                  deferred — Cloudflare challenge
                </span>
              </h2>
              <div className="rounded-lg border border-dashed border-neutral-300 p-4 text-sm text-neutral-500 dark:border-neutral-700">
                Not monitored. No market routes to this brand, so it has no
                column in the grid above.
              </div>
            </section>
          ))}

      <section>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
          Recent runs
          <span className="ml-2 font-normal normal-case tracking-normal text-neutral-400">
            {totalRuns.toLocaleString()} {statusFilter ? statusFilter : "total"}
          </span>
        </h2>
        <FilterTabs status={statusFilter} />
        </div>
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
                  <th className="px-4 py-2 font-medium">Domain</th>
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
                    {/* The host, not the brand id — after the mirror split a
                        bare "stakes3" tells you less than "stakes3.com", and
                        historical rows may carry a brand no longer in COLUMNS. */}
                    <td className="px-4 py-2">
                      {SITE_DOMAINS[run.brand as keyof typeof SITE_DOMAINS] ??
                        run.brand}
                    </td>
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

        {totalPages > 1 && (
          <Pager page={page} totalPages={totalPages} status={statusFilter} />
        )}
      </section>
    </main>
  );
}
