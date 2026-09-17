"use client";

import { useEffect, useState } from "react";

/**
 * The currently-executing check, showing elapsed time against that check's own
 * historical median.
 *
 * Why median-relative and not a raw percentage: a check is atomic — there is no
 * "50% through login". Any percentage drawn from nothing would look precise
 * while meaning nothing. Elapsed-vs-typical is real data (we store durationMs
 * for every run) and it answers the question a spinner cannot: is this slower
 * than normal?
 *
 * The bar caps at 95% and flips to a "slow" state rather than completing. A bar
 * that hits 100% and keeps going is worse than no bar — it asserts the check is
 * finished when it plainly is not.
 */
export function RunningCell({
  startedAtIso,
  medianMs,
}: {
  startedAtIso: string | null;
  medianMs: number | null;
}) {
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, []);

  // Until mounted, render the static label — computing elapsed during SSR would
  // bake in server time and mismatch on hydration.
  if (now === null || !startedAtIso) {
    return <span className="text-xs font-medium">Running</span>;
  }

  const elapsedMs = Math.max(0, now - new Date(startedAtIso).getTime());
  const elapsedS = (elapsedMs / 1000).toFixed(1);

  // No history for this check yet (first ever run) — show elapsed only rather
  // than inventing a denominator.
  if (!medianMs || medianMs <= 0) {
    return (
      <span className="flex flex-col items-center gap-0.5">
        <span className="text-xs font-medium tabular-nums">{elapsedS}s</span>
        <span className="h-1 w-14 overflow-hidden rounded-full bg-white/30">
          <span className="block h-full w-1/3 animate-pulse rounded-full bg-white" />
        </span>
      </span>
    );
  }

  const ratio = elapsedMs / medianMs;
  const slow = ratio > 1.5;
  const pct = Math.min(95, Math.round(ratio * 100));

  return (
    <span className="flex flex-col items-center gap-0.5">
      <span className="text-xs font-medium tabular-nums">
        {slow ? `${elapsedS}s · slow` : `${pct}%`}
      </span>
      <span
        className="h-1 w-14 overflow-hidden rounded-full bg-white/30"
        title={`${elapsedS}s elapsed · typically ${(medianMs / 1000).toFixed(1)}s`}
      >
        <span
          className={`block h-full rounded-full transition-all duration-300 ${
            slow ? "bg-amber-300" : "bg-white"
          }`}
          style={{ width: `${slow ? 95 : pct}%` }}
        />
      </span>
    </span>
  );
}
