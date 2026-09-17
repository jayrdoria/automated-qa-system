import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getEnv } from "@/lib/env";

export const dynamic = "force-dynamic";

/**
 * Live run progress. Deliberately separate from /api/results:
 *
 *   /api/results  — end of run, durable history, drives alerting
 *   /api/progress — during the run, volatile UI state, never alerts
 *
 * Merging them would fire alert transitions per-test and write partial runs
 * into history. This endpoint cannot affect either.
 */
const schema = z.object({
  brand: z.enum(["stakes", "x7"]),
  region: z.string().regex(/^[A-Z]{2}$/),
  total: z.number().int().positive().max(100),
  completed: z.number().int().nonnegative().max(100),
  passed: z.number().int().nonnegative().max(100),
  failed: z.number().int().nonnegative().max(100),
  currentCheck: z.string().max(64).nullable().optional(),
  results: z.record(z.string(), z.enum(["pass", "fail"])).optional(),
  currentStartedAt: z.string().datetime().nullable().optional(),
  done: z.boolean(),
});

function tokenValid(header: string | null): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const provided = Buffer.from(header.slice(7));
  const expected = Buffer.from(getEnv().INGEST_TOKEN);
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}

export async function POST(request: Request) {
  if (!tokenValid(request.headers.get("authorization"))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Malformed JSON" }, { status: 400 });
  }

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Validation failed" }, { status: 400 });
  }
  const p = parsed.data;

  try {
    const now = new Date();
    await prisma.runProgress.upsert({
      where: { brand_region: { brand: p.brand, region: p.region } },
      create: {
        brand: p.brand,
        region: p.region,
        total: p.total,
        completed: p.completed,
        passed: p.passed,
        failed: p.failed,
        currentCheck: p.currentCheck ?? null,
        results: p.results ?? {},
        currentStartedAt: p.currentStartedAt ? new Date(p.currentStartedAt) : null,
        startedAt: now,
        finishedAt: p.done ? now : null,
      },
      update: {
        total: p.total,
        completed: p.completed,
        passed: p.passed,
        failed: p.failed,
        currentCheck: p.done ? null : (p.currentCheck ?? null),
        results: p.results ?? {},
        currentStartedAt:
          p.done || !p.currentStartedAt ? null : new Date(p.currentStartedAt),
        // completed === 0 marks the start of a new run — reset the window so a
        // stale startedAt from the previous run can't make this one look old.
        ...(p.completed === 0 ? { startedAt: now } : {}),
        finishedAt: p.done ? now : null,
      },
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("progress upsert failed:", error);
    return NextResponse.json({ error: "Failed" }, { status: 500 });
  }
}
