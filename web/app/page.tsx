import { prisma } from "@/lib/prisma";
import {
  BRANDS,
  BRAND_LABELS,
  SITE_DOMAINS,
  CHECKS,
  CHECK_LABELS,
  COLUMNS,
  DEFERRED_BRANDS,
  RUN_INTERVAL_MIN,
  RUN_GRACE_MIN,
  STALE_AFTER_MIN,
  gameName,
  type Brand,
} from "@/lib/checks";
import { explainFailure, isBlockedError, VERDICT_LABELS, type Verdict } from "@/lib/failures";
import { groupRun, consequenceReason } from "@/lib/incidents";
import {
  parseRunsFilter,
  toWhere,
  filterQuery,
  isFiltered,
  RUN_STATUSES,
  STATUS_FILTER_LABELS,
  type RunsFilter,
} from "@/lib/runs-query";
import { formatLocal } from "@/lib/email";
import { RunStatus } from "./RunStatus";
import { AutoRefresh } from "./AutoRefresh";
import { RunningCell } from "./RunningCell";

// Cron writes new rows every 20 min — never cache this.
export const dynamic = "force-dynamic";

/// Defined in lib/checks.ts because it is a function of RUN_INTERVAL_MIN and
/// the number of columns contending for the global run lock — not a property
/// of the page.
const STALE_AFTER_MS = STALE_AFTER_MIN * 60 * 1000;

const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? "/automated-qa-system";

type Status =
  | "pass"
  | "fail"
  | "blocked" // Cloudflare refused the VPN exit — the site was never tested
  | "stale"
  | "none"
  | "running" // this exact check is executing right now
  | "queued"; // in this run, not reached yet

interface LatestRow {
  status: string;
  startedAt: Date;
  durationMs: number;
  error: string | null;
  target: string | null;
}

function statusOf(lastRun: LatestRow | undefined): Status {
  if (!lastRun) return "none";
  if (Date.now() - lastRun.startedAt.getTime() > STALE_AFTER_MS) return "stale";
  if (lastRun.status === "pass") return "pass";
  // Stored as "fail" by the runner, but it is evidence about the route, not the
  // site — shown grey and never counted as failing.
  return isBlockedError(lastRun.error) ? "blocked" : "fail";
}

/** Compact cell styling for the matrix — colour carries the signal, the word confirms it. */
const CELL_STYLES: Record<Status, string> = {
  running: "bg-sky-500 text-white dark:bg-sky-500 dark:text-white font-medium animate-pulse",
  queued: "bg-neutral-100 text-neutral-400 dark:bg-neutral-900 dark:text-neutral-600",
  pass: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  fail: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
  blocked: "bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
  stale: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  none: "bg-neutral-100 text-neutral-400 dark:bg-neutral-900 dark:text-neutral-600",
};

/// Never colour alone — these labels keep the grid readable for colour-blind
/// users and when it is printed or screenshotted into Slack.
const CELL_LABELS: Record<Status, string> = {
  running: "Running",
  queued: "Queued",
  pass: "Pass",
  fail: "Fail",
  blocked: "Blocked",
  stale: "Stale",
  none: "—",
};

const STATUS_LABELS: Record<Status, string> = {
  running: "Running now",
  queued: "Waiting in this run",
  pass: "Passing",
  fail: "Failing",
  blocked: "Blocked by Cloudflare — the site was not tested",
  stale: "Stale",
  none: "No data",
};

const VERDICT_STYLES: Record<Verdict, string> = {
  site: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
  flaky: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  network: "bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300",
  blocked: "bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
  unknown: "bg-neutral-200 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300",
};

function VerdictBadge({ verdict }: { verdict: Verdict }) {
  return (
    <span
      className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-medium ${VERDICT_STYLES[verdict]}`}
    >
      {VERDICT_LABELS[verdict]}
    </span>
  );
}

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
  filter,
}: {
  page: number;
  totalPages: number;
  filter: RunsFilter;
}) {
  // Every page link carries the active filters — paging must never silently
  // widen a filtered view back to "all".
  const href = (p: number) => filterQuery(filter, { page: p });
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

const inputCls =
  "rounded border border-neutral-300 bg-white px-2 py-1 text-xs dark:border-neutral-700 dark:bg-neutral-900";

/**
 * Plain GET form: no client JS, the URL is the state, and a filtered view can be
 * bookmarked or pasted into Slack. "Download CSV" submits the SAME form to the
 * export route, so the file always matches the fields as currently set — even
 * ones edited but not yet applied.
 */
function RunsFilterForm({ filter }: { filter: RunsFilter }) {
  const today = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Manila" }).format(new Date());
  return (
    <form method="get" className="mb-3 flex flex-wrap items-end gap-2 text-xs">
      <label className="flex flex-col gap-1 text-neutral-500">
        From
        <input type="date" name="from" max={today} defaultValue={filter.from ?? ""} className={inputCls} />
      </label>
      <label className="flex flex-col gap-1 text-neutral-500">
        To
        <input type="date" name="to" max={today} defaultValue={filter.to ?? ""} className={inputCls} />
      </label>
      <label className="flex flex-col gap-1 text-neutral-500">
        Status
        <select name="status" defaultValue={filter.status} className={inputCls}>
          {RUN_STATUSES.map((s) => (
            <option key={s} value={s}>
              {STATUS_FILTER_LABELS[s]}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-neutral-500">
        Domain
        <select name="domain" defaultValue={filter.domain ?? ""} className={inputCls}>
          <option value="">All</option>
          {BRANDS.filter((b) => !DEFERRED_BRANDS.includes(b)).map((b) => (
            <option key={b} value={b}>
              {SITE_DOMAINS[b]}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-neutral-500">
        Region
        <select name="region" defaultValue={filter.region ?? ""} className={inputCls}>
          <option value="">All</option>
          {COLUMNS.map((c) => (
            <option key={c.region} value={c.region}>
              {c.region} · {c.label}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-neutral-500">
        Check
        <select name="check" defaultValue={filter.check ?? ""} className={inputCls}>
          <option value="">All</option>
          {CHECKS.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </select>
      </label>
      <button
        type="submit"
        className="rounded bg-neutral-900 px-3 py-1.5 font-medium text-white hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300"
      >
        Apply
      </button>
      <a
        href="?"
        className="rounded px-3 py-1.5 text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800"
      >
        Reset
      </a>
      <button
        type="submit"
        formAction={`${BASE_PATH}/api/export`}
        className="ml-auto rounded border border-neutral-300 px-3 py-1.5 font-medium hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800"
        title="Download the runs matching these filters as CSV (dates are +08:00)"
      >
        Download CSV
      </button>
    </form>
  );
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
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const pageRaw = Array.isArray(sp.page) ? sp.page[0] : sp.page;
  const pageParam = Number(pageRaw ?? "1");
  const page = Number.isFinite(pageParam) && pageParam > 0 ? Math.floor(pageParam) : 1;

  // An invalid filter falls back to "everything" with a visible notice, rather
  // than a 500 or a silently different result set.
  const parsedFilter = parseRunsFilter(sp);
  const filter = parsedFilter.filter;
  const where = toWhere(filter);

  const [latestRuns, recentRuns, totalRuns, progressRows, medianRows] = await Promise.all([
    // Postgres DISTINCT ON — the newest row per brand/region/check, and per GAME
    // for game-load, so a broken game is not hidden behind a passing one that
    // happened to run more recently.
    prisma.$queryRaw<
      {
        brand: string;
        region: string;
        check_name: string;
        status: string;
        started_at: Date;
        duration_ms: number;
        error: string | null;
        target: string | null;
      }[]
    >`
      SELECT DISTINCT ON (brand, region, check_name, COALESCE(target, ''))
        brand, region, check_name, status, started_at, duration_ms, error, target
      FROM check_run
      ORDER BY brand, region, check_name, COALESCE(target, ''), started_at DESC
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

  const medianByCheck = new Map(medianRows.map((m) => [m.check_name, Number(m.median_ms)]));

  // Completion times for every region, live or not — the countdown measures
  // from the end of the last run, matching scripts/run-checks.sh.
  const lastFinishedByRegion = new Map(
    progressRows
      .filter((p) => p.finishedAt !== null)
      .map((p) => [p.region, p.finishedAt!.toISOString()]),
  );

  // All latest rows for a cell. Several for game-load (one per game).
  const rowsByKey = new Map<string, LatestRow[]>();
  for (const r of latestRuns) {
    const k = `${r.brand}:${r.region}:${r.check_name}`;
    rowsByKey.set(k, [
      ...(rowsByKey.get(k) ?? []),
      {
        status: r.status,
        startedAt: r.started_at,
        durationMs: r.duration_ms,
        error: r.error,
        target: r.target,
      },
    ]);
  }

  /**
   * The row a cell represents. For single-target checks, the only row. For
   * game-load, the WORST current game: a cell is red while any game's latest
   * result is a real failure, even if the rotation has since passed a different
   * game. Otherwise a broken Multifly would flash red for one run an hour and
   * look green the rest of the time.
   */
  function cellRow(key: string): { row: LatestRow | undefined; games: LatestRow[] } {
    const rows = rowsByKey.get(key) ?? [];
    const targeted = rows.filter((r) => r.target);
    if (targeted.length === 0) {
      const row = rows.slice().sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())[0];
      return { row, games: [] };
    }
    // Pre-rotation rows (target NULL) are superseded once any game has reported.
    const fresh = targeted.filter((r) => statusOf(r) !== "stale");
    const pool = fresh.length ? fresh : targeted;
    const newestFirst = pool.slice().sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
    const row = newestFirst.find((r) => statusOf(r) === "fail") ?? newestFirst[0];
    return { row, games: targeted };
  }

  /*
   * A run counts as live only if all three hold:
   *   - it has not reported finishing
   *   - it started recently (a killed runner must not strand the UI)
   *   - check_run does NOT already hold a full set of results newer than it
   *
   * That last one is the self-heal. The "done" ping is fire-and-forget, so a
   * dropped packet used to leave the header frozen at "3/7 running" while the
   * end-of-run batch wrote all seven results underneath. If every check has a
   * fresh result, the run is over whatever the ping said.
   *
   * `some`, not `find`: game-load has one latest row per game, and only the
   * game tested in THIS run is new — the others are from earlier rotations.
   */
  const fullResultsSince = (brand: string, region: string, since: Date) =>
    CHECKS.every((c) =>
      (rowsByKey.get(`${brand}:${region}:${c.id}`) ?? []).some((r) => r.startedAt >= since),
    );

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

  /*
   * Surfaced above the matrix so a failure is readable at a glance — the grid
   * says WHICH cell is red, this says WHY, without a click.
   *
   * Grouped into incidents with the same rules as the alert emails: when the
   * site or its login is broken, the checks below it fail too, and listing
   * each as its own failure made one outage read like five.
   */
  const incidents = shownColumns.flatMap((col) => {
    // A column mid-run has no current verdict — excluded so the panel doesn't
    // flash last cycle's errors while they are being retested.
    if (progressByRegion.has(col.region)) return [];
    const items = CHECKS.map((c) => {
      const { row } = cellRow(`${col.site}:${col.region}:${c.id}`);
      return { checkName: c.id, failed: statusOf(row) === "fail", row };
    });
    const grouped = groupRun(items);
    return grouped.incidents.map(({ root, consequences }) => ({
      key: `${col.site}:${col.region}:${root.checkName}`,
      domain: SITE_DOMAINS[col.site],
      region: col.region,
      market: col.label,
      check:
        (CHECK_LABELS[root.checkName] ?? root.checkName) +
        (root.row?.target ? ` — ${gameName(root.row.target)}` : ""),
      explanation: explainFailure(root.row?.error),
      since: root.row?.startedAt,
      consequences: consequences.map((c) => CHECK_LABELS[c.checkName] ?? c.checkName),
      reason: consequenceReason(root.checkName, grouped.allFailed),
      allFailed: grouped.allFailed,
    }));
  });

  const blockedCells = shownColumns
    .filter((col) => !progressByRegion.has(col.region))
    .flatMap((col) => CHECKS.map((c) => statusOf(cellRow(`${col.site}:${col.region}:${c.id}`).row)))
    .filter((s) => s === "blocked").length;

  return (
    <main className="mx-auto max-w-6xl px-6 py-10">
      <AutoRefresh live={progressByRegion.size > 0} />
      <header className="mb-8 flex flex-wrap items-baseline justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Automated QA Monitor</h1>
          <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
            {shownColumns.map((c) => c.region).join(" · ")} · each column checked every{" "}
            {RUN_INTERVAL_MIN} minutes
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {blockedCells > 0 && (
            <span
              className="rounded-full bg-slate-200 px-3 py-1 text-sm font-medium text-slate-700 dark:bg-slate-800 dark:text-slate-300"
              title="Cloudflare refused the VPN exit, so these checks never reached the site. Not counted as failures."
            >
              {blockedCells} blocked
            </span>
          )}
          <span
            className={`rounded-full px-3 py-1 text-sm font-medium ${
              incidents.length > 0
                ? "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-200"
                : "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200"
            }`}
          >
            {incidents.length > 0
              ? `${incidents.length} ${incidents.length === 1 ? "incident" : "incidents"}`
              : "All green"}
          </span>
        </div>
      </header>

      {incidents.length > 0 && (
        <section className="mb-8 rounded-lg border border-red-200 bg-red-50/50 p-4 dark:border-red-900 dark:bg-red-950/20">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-red-800 dark:text-red-300">
            Current failures
          </h2>
          <ul className="space-y-3">
            {incidents.map((f) => (
              <li key={f.key} className="text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">
                    {f.allFailed
                      ? `${f.domain} · ${f.region} — down or in maintenance`
                      : `${f.domain} · ${f.region} · ${f.check}`}
                  </span>
                  <VerdictBadge verdict={f.explanation.verdict} />
                  {f.since && (
                    <span className="text-xs text-neutral-500" title={formatLocal(f.since)}>
                      {timeAgo(f.since)}
                    </span>
                  )}
                </div>
                <p className="mt-0.5 text-neutral-800 dark:text-neutral-200">
                  {f.explanation.headline}
                </p>
                <p className="text-xs text-neutral-600 dark:text-neutral-400">
                  {f.explanation.detail}
                </p>
                {f.consequences.length > 0 && (
                  <p className="mt-1 text-xs text-neutral-600 dark:text-neutral-400">
                    {f.reason}: {f.consequences.join(", ")} also failed.
                  </p>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="mb-10">
        {/* One matrix for everything. Each column is a (market, domain) pair,
            because a market is served by exactly one mirror — so the domain
            belongs in the header, not in a separate table per brand. */}
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
                      {/* Without this you cannot tell which host a green cell refers to. */}
                      <span className="text-[10px] font-normal text-neutral-400 dark:text-neutral-500">
                        {SITE_DOMAINS[col.site]}
                      </span>
                      {(() => {
                        const live = progressByRegion.get(col.region);
                        if (!live) {
                          return (
                            <RunStatus
                              cronOffset={col.cronOffset}
                              lastFinishedIso={lastFinishedByRegion.get(col.region) ?? null}
                              lastRunIso={lastRunByRegion.get(col.region) ?? null}
                            />
                          );
                        }
                        const pct = Math.round((live.completed / live.total) * 100);
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
                <tr key={check.id} className="border-t border-neutral-200 dark:border-neutral-800">
                  <td className="px-4 py-2 font-medium">{check.label}</td>
                  {shownColumns.map((col) => {
                    const { row: last, games } = cellRow(`${col.site}:${col.region}:${check.id}`);
                    const live = progressByRegion.get(col.region);
                    /*
                     * Row lifecycle during a live run, resolved in order:
                     *   1. this check is executing        -> running
                     *   2. it finished in THIS run        -> pass/fail now
                     *   3. it is in this run, not reached -> queued
                     *   4. no run in flight               -> last known result
                     *
                     * A result older than the run start is last cycle's answer;
                     * showing it as confident green is the lie worth avoiding.
                     * Step 2 is why progress carries per-check outcomes: check_run
                     * is written as one batch at the end.
                     */
                    const liveResult = live?.results?.[check.id];
                    const notYetRerun =
                      live !== undefined && (!last || last.startedAt < live.startedAt);
                    const status: Status =
                      live && live.currentCheck === check.id
                        ? "running"
                        : liveResult
                          ? liveResult
                          : notYetRerun
                            ? "queued"
                            : statusOf(last);

                    const tooltip = last
                      ? [
                          `${STATUS_LABELS[status]} · ${timeAgo(last.startedAt)} · ${(last.durationMs / 1000).toFixed(1)}s`,
                          ...(games.length > 0
                            ? games
                                .slice()
                                .sort((a, b) => (gameName(a.target) ?? "").localeCompare(gameName(b.target) ?? ""))
                                .map(
                                  (g) =>
                                    `${gameName(g.target)}: ${CELL_LABELS[statusOf(g)]} (${timeAgo(g.startedAt)})`,
                                )
                            : []),
                          status === "fail" || status === "blocked"
                            ? explainFailure(last.error).headline
                            : null,
                        ]
                          .filter(Boolean)
                          .join("\n")
                      : STATUS_LABELS[status];

                    return (
                      <td key={col.region} className="px-3 py-2 text-center">
                        <span
                          title={tooltip}
                          className={`inline-flex min-w-[64px] items-center justify-center rounded px-2 py-1 text-xs font-medium ${CELL_STYLES[status]}`}
                        >
                          {status === "running" ? (
                            <RunningCell
                              startedAtIso={live?.currentStartedAt?.toISOString() ?? null}
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
          Cloudflare interactive challenge that a VPN cannot clear. Shown as
          deferred rather than omitted, so "not monitored" never reads as
          "monitored and healthy". */}
      {DEFERRED_BRANDS.map((brand) => (
        <section key={brand} className="mb-10">
          <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
            {BRAND_LABELS[brand as Brand] ?? brand}
            <span className="rounded bg-neutral-200 px-2 py-0.5 text-[11px] font-medium normal-case tracking-normal text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400">
              deferred — Cloudflare challenge
            </span>
          </h2>
          <div className="rounded-lg border border-dashed border-neutral-300 p-4 text-sm text-neutral-500 dark:border-neutral-700">
            Not monitored. No market routes to this brand, so it has no column in the grid above.
          </div>
        </section>
      ))}

      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
          Recent runs
          <span className="ml-2 font-normal normal-case tracking-normal text-neutral-400">
            {totalRuns.toLocaleString()} {isFiltered(filter) ? "matching" : "total"}
          </span>
        </h2>

        <RunsFilterForm filter={filter} />

        {!parsedFilter.ok && (
          <p className="mb-3 rounded border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-300">
            Filter ignored — {parsedFilter.error}. Showing all runs.
          </p>
        )}

        {recentRuns.length === 0 ? (
          <p className="rounded-lg border border-dashed border-neutral-300 p-8 text-center text-sm text-neutral-500 dark:border-neutral-700">
            {isFiltered(filter)
              ? "No runs match these filters."
              : "No check results yet. The dashboard populates once the cron runner posts its first results."}
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
                  <th className="px-4 py-2 font-medium">What happened</th>
                </tr>
              </thead>
              <tbody>
                {recentRuns.map((run) => {
                  const blocked = run.status === "fail" && isBlockedError(run.error);
                  const x = run.status === "fail" ? explainFailure(run.error) : null;
                  return (
                    <tr
                      key={run.id}
                      className="border-t border-neutral-200 align-top dark:border-neutral-800"
                    >
                      <td
                        className="whitespace-nowrap px-4 py-2 text-neutral-500"
                        title={formatLocal(run.startedAt)}
                      >
                        {timeAgo(run.startedAt)}
                      </td>
                      {/* The host, not the brand id — and historical rows may
                          carry a brand no longer in COLUMNS. */}
                      <td className="px-4 py-2">
                        {SITE_DOMAINS[run.brand as Brand] ?? run.brand}
                      </td>
                      <td className="px-4 py-2 text-neutral-500">{run.region}</td>
                      <td className="px-4 py-2">
                        {CHECK_LABELS[run.checkName] ?? run.checkName}
                        {run.target && (
                          <span className="block text-xs text-neutral-500">
                            {gameName(run.target)}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-2">
                        <span
                          className={
                            run.status === "pass"
                              ? "text-emerald-600 dark:text-emerald-400"
                              : blocked
                                ? "text-slate-500"
                                : "text-red-600 dark:text-red-400"
                          }
                        >
                          {blocked ? "blocked" : run.status}
                        </span>
                      </td>
                      <td className="whitespace-nowrap px-4 py-2 text-neutral-500">
                        {(run.durationMs / 1000).toFixed(1)}s
                      </td>
                      <td className="max-w-md px-4 py-2 text-neutral-600 dark:text-neutral-400">
                        {x ? (
                          // Readable first; the raw Playwright log is one click
                          // away for whoever is actually debugging.
                          <details>
                            <summary className="cursor-pointer">
                              <span className="text-neutral-800 dark:text-neutral-200">
                                {x.headline}
                              </span>
                            </summary>
                            <div className="mt-1 space-y-1.5">
                              <p className="text-xs">{x.detail}</p>
                              <VerdictBadge verdict={x.verdict} />
                              {x.technical && (
                                <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-neutral-100 p-2 font-mono text-[11px] text-neutral-600 dark:bg-neutral-900 dark:text-neutral-400">
                                  {x.technical}
                                </pre>
                              )}
                            </div>
                          </details>
                        ) : (
                          "—"
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {totalPages > 1 && <Pager page={page} totalPages={totalPages} filter={filter} />}
      </section>
    </main>
  );
}
