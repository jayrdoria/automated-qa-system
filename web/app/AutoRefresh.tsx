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
export function AutoRefresh({ seconds = 15 }: { seconds?: number }) {
  const router = useRouter();
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    const onVis = () => setPaused(document.hidden);
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  useEffect(() => {
    if (paused) return;
    const t = setInterval(() => router.refresh(), seconds * 1000);
    return () => clearInterval(t);
  }, [router, seconds, paused]);

  return null;
}
