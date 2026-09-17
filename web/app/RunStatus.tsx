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
  cronOffset,
  lastFinishedIso,
  lastRunIso,
}: {
  cronOffset: number;
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

  /*
   * Becoming due is not the same as running. The region then waits for the next
   * cron tick IN ITS OWN SEQUENCE — FR fires at :00,:05,…, IT at :02,:07,…
   *
   * Rounding to a generic 5-minute boundary (the previous approach) ignored the
   * per-region offset and was wrong by up to 4 minutes, which is exactly the
   * "next 2 mins" that then started immediately.
   */
  const offset = ((cronOffset % CRON_TICK_MIN) + CRON_TICK_MIN) % CRON_TICK_MIN;
  const tick = new Date(dueAt);
  tick.setSeconds(0, 0);
  // At most CRON_TICK_MIN iterations.
  while (tick.getTime() < dueAt || tick.getMinutes() % CRON_TICK_MIN !== offset) {
    tick.setTime(tick.getTime() + 60_000);
  }
  const secsToNext = Math.round((tick.getTime() - now) / 1000);

  if (secsToNext <= 0) {
    return (
      <span className="text-[11px] font-medium text-amber-600 dark:text-amber-400">
        due now
      </span>
    );
  }

  const m = Math.floor(secsToNext / 60);
  const sec = secsToNext % 60;
  /*
   * "~" because this is the EARLIEST opportunity, not a guarantee. Only one
   * region runs at a time (global lock), so a region whose tick arrives while
   * another is mid-run waits for its next one. Presenting that as an exact
   * countdown would be precise and wrong.
   */
  return (
    <span
      className="text-[11px] tabular-nums text-neutral-400 dark:text-neutral-500"
      title={`Earliest next run ${tick.toLocaleTimeString()} — may slip if another region is still running`}
    >
      ~{m}:{String(sec).padStart(2, "0")}
    </span>
  );
}
