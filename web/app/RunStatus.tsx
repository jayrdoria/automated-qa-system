"use client";

import { useEffect, useState } from "react";
import { RUN_INTERVAL_MIN, CRON_TICK_MIN } from "@/lib/checks";

/**
 * Countdown to a region's next run.
 *
 * Shown only when no run is in flight — a live run renders the progress bar
 * instead, driven by real reported data rather than inferred from a clock.
 */
export function RunStatus({
  lastFinishedIso,
  lastRunIso,
}: {
  lastFinishedIso: string | null;
  lastRunIso: string | null;
}) {
  // null until mounted: computing this during SSR would render a countdown
  // from server time and then mismatch on hydration.
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  if (now === null) {
    return <span className="text-[11px] text-neutral-400">&nbsp;</span>;
  }

  const lastRun = lastRunIso ? new Date(lastRunIso).getTime() : 0;

  /*
   * Only claim a schedule exists when this region has actually reported
   * recently. Otherwise a machine with no cron at all — every local dev
   * environment — displays a confident countdown for a schedule that does not
   * exist.
   */
  const scheduleLooksActive =
    lastRun > 0 && now - lastRun < RUN_INTERVAL_MIN * 3 * 60_000;

  if (!scheduleLooksActive) {
    return (
      <span className="text-[11px] text-neutral-400 dark:text-neutral-600">
        {lastRun > 0 ? "not scheduled" : "no data"}
      </span>
    );
  }

  const finished = lastFinishedIso ? new Date(lastFinishedIso).getTime() : lastRun;

  /*
   * The interval runs from COMPLETION, not from a fixed clock — matching
   * scripts/run-checks.sh, which exits early unless RUN_INTERVAL_MIN has
   * elapsed since this region last finished.
   *
   * Computing against fixed :00/:20/:40 offsets (the old model) told you "next
   * in 3 mins" seconds after a run ended, when the real answer was ~20.
   */
  const dueAt = finished + RUN_INTERVAL_MIN * 60_000;

  // It then waits for the next cron tick after becoming due.
  const tickMs = CRON_TICK_MIN * 60_000;
  const nextAt = Math.ceil(dueAt / tickMs) * tickMs;
  const secsToNext = Math.round((nextAt - now) / 1000);

  if (secsToNext <= 0) {
    return (
      <span className="text-[11px] font-medium text-amber-600 dark:text-amber-400">
        due now
      </span>
    );
  }

  const m = Math.floor(secsToNext / 60);
  const sec = secsToNext % 60;
  return (
    <span className="text-[11px] tabular-nums text-neutral-400 dark:text-neutral-500">
      next {m}:{String(sec).padStart(2, "0")}
    </span>
  );
}
