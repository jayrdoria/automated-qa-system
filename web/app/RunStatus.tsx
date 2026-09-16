"use client";

import { useEffect, useState } from "react";
import { RUN_INTERVAL_MIN, RUN_GRACE_MIN } from "@/lib/checks";

/**
 * Live per-region schedule indicator.
 *
 * Derived from the cron offsets rather than reported by the runner: adding a
 * "run started" ping would mean a new endpoint, a new table and a write on
 * every tick, to display something the schedule already tells us.
 *
 * Trade-off worth knowing: this infers "running" from the clock, so a run that
 * dies instantly still shows as running until the grace period lapses. That is
 * why it flips to "late" rather than staying optimistic.
 */
export function RunStatus({
  cronOffset,
  lastRunIso,
}: {
  cronOffset: number;
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

  const d = new Date(now);
  const mins = d.getMinutes();

  // Minutes until the next tick for this region.
  const sinceLastTick =
    (((mins - cronOffset) % RUN_INTERVAL_MIN) + RUN_INTERVAL_MIN) %
    RUN_INTERVAL_MIN;
  const minsToNext = RUN_INTERVAL_MIN - sinceLastTick;
  const secsToNext = minsToNext * 60 - d.getSeconds();

  // When did the most recent scheduled tick happen?
  const lastTick = new Date(d);
  lastTick.setMinutes(mins - sinceLastTick, 0, 0);

  const lastRun = lastRunIso ? new Date(lastRunIso).getTime() : 0;
  const tickPassedWithoutResult = lastRun < lastTick.getTime();
  const sinceTickMin = (now - lastTick.getTime()) / 60000;

  if (tickPassedWithoutResult && sinceTickMin <= RUN_GRACE_MIN) {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] font-medium text-sky-600 dark:text-sky-400">
        <span className="relative flex h-1.5 w-1.5">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-sky-400 opacity-75" />
          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-sky-500" />
        </span>
        running
      </span>
    );
  }

  if (tickPassedWithoutResult) {
    return (
      <span className="text-[11px] font-medium text-amber-600 dark:text-amber-400">
        late {Math.floor(sinceTickMin)}m
      </span>
    );
  }

  const m = Math.floor(secsToNext / 60);
  const s = secsToNext % 60;
  return (
    <span className="text-[11px] tabular-nums text-neutral-400 dark:text-neutral-500">
      next {m}:{String(s).padStart(2, "0")}
    </span>
  );
}
