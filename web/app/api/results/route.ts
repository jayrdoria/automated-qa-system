import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getEnv } from "@/lib/env";
import { processResults } from "@/lib/alerting";
import { BRANDS } from "@/lib/checks";

export const dynamic = "force-dynamic";

const resultSchema = z.object({
  /*
   * Sourced from BRANDS rather than a literal list. When this was hardcoded to
   * ["stakes","x7"], adding a mirror domain meant the runner POSTed valid
   * results and got a 400 — the reporter logs the rejection but never fails the
   * run, so cron reported success while the dashboard silently received nothing.
   */
  brand: z.enum(BRANDS),
  region: z.string().regex(/^[A-Z]{2}$/).default("FR"),
  checkName: z.string().min(1).max(64),
  status: z.enum(["pass", "fail"]),
  durationMs: z.number().int().nonnegative(),
  error: z.string().max(4000).nullable().optional(),
  screenshot: z.string().max(512).nullable().optional(),
  startedAt: z.string().datetime(),
  /// Set when the request never reached the brand (CDN edge block / geo).
  blocked: z.boolean().optional(),
  /// The game game-load rotated to, or null. Optional so an older runner
  /// image that does not send it keeps working through a deploy.
  target: z
    .string()
    .regex(/^[a-z0-9-]{1,64}$/, "target must be a lowercase slug")
    .nullable()
    .optional(),
});

const payloadSchema = z.object({
  results: z.array(resultSchema).min(1).max(100),
});

function tokenValid(header: string | null): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const provided = Buffer.from(header.slice(7));
  const expected = Buffer.from(getEnv().INGEST_TOKEN);
  // Length must match before timingSafeEqual or it throws.
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

  const parsed = payloadSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const { results } = parsed.data;

  try {
    await prisma.checkRun.createMany({
      data: results.map((r) => ({
        brand: r.brand,
        region: r.region,
        checkName: r.checkName,
        status: r.status,
        durationMs: r.durationMs,
        error: r.error ?? null,
        screenshot: r.screenshot ?? null,
        target: r.target ?? null,
        startedAt: new Date(r.startedAt),
      })),
    });

    // Alerting must never make the runner think ingestion failed — the results
    // are already durable at this point.
    try {
      await processResults(results);
    } catch (alertError) {
      console.error("Alerting failed after successful ingest:", alertError);
    }

    return NextResponse.json({ ok: true, inserted: results.length }, { status: 201 });
  } catch (error) {
    console.error("Failed to persist check results:", error);
    return NextResponse.json({ error: "Failed to persist results" }, { status: 500 });
  }
}
