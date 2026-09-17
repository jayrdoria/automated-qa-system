"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Pulls fresh server data on an interval.
 *
 * router.refresh() re-runs the server component and patches the tree in place —
 * unlike location.reload() it keeps scroll position and doesn't flash, so a
 * dashboard left open on a wall display stays readable.
 *
 * Paused when the tab is hidden: a backgrounded tab polling every 15s all
 * weekend is pure load on a box that is also running the checks themselves.
 */
export function AutoRefresh({
  live = false,
  idleSeconds = 15,
  liveSeconds = 2,
}: {
  live?: boolean;
  idleSeconds?: number;
  liveSeconds?: number;
}) {
  const router = useRouter();
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    const onVis = () => setPaused(document.hidden);
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  /*
   * Adaptive interval. Checks take 5–20s, so a flat 15s poll misses the fast
   * ones entirely: two or three complete between refreshes and appear to finish
   * simultaneously, which reads as rows being skipped.
   *
   * 2s while a run is live means even the quickest check is observed in the
   * Running state at least twice. Idle stays slow — polling every 2s all day
   * would be constant load on the box that also runs the checks.
   */
  const seconds = live ? liveSeconds : idleSeconds;

  useEffect(() => {
    if (paused) return;
    const t = setInterval(() => router.refresh(), seconds * 1000);
    return () => clearInterval(t);
  }, [router, seconds, paused]);

  return null;
}
