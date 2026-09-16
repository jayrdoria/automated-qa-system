import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getEnv } from "@/lib/env";
import { processResults } from "@/lib/alerting";

export const dynamic = "force-dynamic";

const resultSchema = z.object({
  brand: z.enum(["stakes", "x7"]),
  region: z.string().regex(/^[A-Z]{2}$/).default("FR"),
  checkName: z.string().min(1).max(64),
  status: z.enum(["pass", "fail"]),
  durationMs: z.number().int().nonnegative(),
  error: z.string().max(4000).nullable().optional(),
  screenshot: z.string().max(512).nullable().optional(),
  startedAt: z.string().datetime(),
  /// Set when the request never reached the brand (CDN edge block / geo).
  blocked: z.boolean().optional(),
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
