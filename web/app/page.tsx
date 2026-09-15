import { prisma } from "@/lib/prisma";
import { BRANDS, BRAND_LABELS, CHECKS } from "@/lib/checks";

// Cron writes new rows every 20 min — never cache this.
export const dynamic = "force-dynamic";

/// A check whose last run is older than this is reported as stale rather than
/// passing. Without it, a dead cron looks identical to everything being green,
/// which is the most dangerous failure mode a monitoring dashboard has.
const STALE_AFTER_MS = 45 * 60 * 1000;

type Status = "pass" | "fail" | "stale" | "none";

function statusOf(lastRun: { status: string; startedAt: Date } | undefined): Status {
  if (!lastRun) return "none";
  if (Date.now() - lastRun.startedAt.getTime() > STALE_AFTER_MS) return "stale";
  return lastRun.status === "pass" ? "pass" : "fail";
}

const STATUS_STYLES: Record<Status, string> = {
  pass: "border-l-[var(--color-pass)] bg-emerald-50/50 dark:bg-emerald-950/20",
  fail: "border-l-[var(--color-fail)] bg-red-50/50 dark:bg-red-950/20",
  stale: "border-l-[var(--color-stale)] bg-amber-50/50 dark:bg-amber-950/20",
  none: "border-l-neutral-300 dark:border-l-neutral-700",
};

const STATUS_LABELS: Record<Status, string> = {
  pass: "Passing",
  fail: "Failing",
  stale: "Stale",
  none: "No data",
};

function timeAgo(date: Date): string {
  const mins = Math.round((Date.now() - date.getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export default async function DashboardPage() {
  const [latestRuns, recentRuns] = await Promise.all([
    // Postgres DISTINCT ON — one row per brand/check, the newest.
    prisma.$queryRaw<
      { brand: string; check_name: string; status: string; started_at: Date; duration_ms: number }[]
    >`
      SELECT DISTINCT ON (brand, check_name)
        brand, check_name, status, started_at, duration_ms
      FROM check_run
      ORDER BY brand, check_name, started_at DESC
    `,
    prisma.checkRun.findMany({
      orderBy: { startedAt: "desc" },
      take: 50,
    }),
  ]);

  const byKey = new Map(
    latestRuns.map((r) => [
      `${r.brand}:${r.check_name}`,
      { status: r.status, startedAt: r.started_at, durationMs: r.duration_ms },
    ]),
  );

  const failing = BRANDS.flatMap((b) =>
    CHECKS.map((c) => statusOf(byKey.get(`${b}:${c.id}`))),
  ).filter((s) => s === "fail").length;

  return (
    <main className="mx-auto max-w-6xl px-6 py-10">
      <header className="mb-8 flex flex-wrap items-baseline justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">QA Monitor</h1>
          <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
            Stakes.com &amp; X7 Casino · checks run every 20 minutes
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

      {BRANDS.map((brand) => (
        <section key={brand} className="mb-10">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
            {BRAND_LABELS[brand]}
          </h2>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {CHECKS.map((check) => {
              const last = byKey.get(`${brand}:${check.id}`);
              const status = statusOf(last);
              return (
                <div
                  key={check.id}
                  className={`rounded-lg border border-neutral-200 border-l-4 p-4 dark:border-neutral-800 ${STATUS_STYLES[status]}`}
                >
                  <div className="font-medium">{check.label}</div>
                  <div className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
                    {STATUS_LABELS[status]}
                    {last && ` · ${timeAgo(last.startedAt)}`}
                  </div>
                  {last && (
                    <div className="mt-0.5 text-xs text-neutral-500 dark:text-neutral-500">
                      {(last.durationMs / 1000).toFixed(1)}s
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      ))}

      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
          Recent runs
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
      </section>
    </main>
  );
}
