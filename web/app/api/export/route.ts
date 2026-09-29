import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { parseRunsFilter, toWhere, type RunsFilter } from "@/lib/runs-query";
import { explainFailure, isBlockedError, VERDICT_LABELS } from "@/lib/failures";
import { CHECK_LABELS, COLUMNS, SITE_DOMAINS, gameName, type Brand } from "@/lib/checks";

export const dynamic = "force-dynamic";

/**
 * CSV export of check runs, using the same filters as the Recent runs table.
 *
 * Streamed in keyset-paginated batches: a full retention window is ~150k rows,
 * which must not be held in memory in a container that shares a box with
 * MailCraft and n8n.
 */

const BATCH = 2_000;
/** Above a full retention window (~62 days × 5 columns × 7 checks × 72 runs). */
const MAX_ROWS = 250_000;

// ── Rate limit ────────────────────────────────────────────────────────────
// The dashboard is unauthenticated and an export is the most expensive request
// it serves. No Redis in this project, and one web container, so an in-memory
// window is sufficient: it resets on restart, which only ever errs permissive.
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 6;
const hits = new Map<string, number[]>();

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  if (recent.length >= MAX_PER_WINDOW) {
    hits.set(ip, recent);
    return true;
  }
  recent.push(now);
  hits.set(ip, recent);
  // Keep the map from growing without bound across many distinct clients.
  if (hits.size > 5_000) {
    for (const [k, v] of hits) if (v.every((t) => now - t >= WINDOW_MS)) hits.delete(k);
  }
  return false;
}

function clientIp(req: Request): string {
  // Apache terminates the connection and forwards the original address.
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
}

// ── CSV ───────────────────────────────────────────────────────────────────
/**
 * Quote every field, and neutralise spreadsheet formulas. Error text is
 * attacker-influenced (it quotes page titles and URLs from third-party sites),
 * so a cell beginning with = + - @ would otherwise execute when opened in Excel.
 */
function cell(v: string | number | null | undefined): string {
  let s = v === null || v === undefined ? "" : String(v);
  if (typeof v === "string" && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

const HEADER = [
  "time_local_+08",
  "time_utc",
  "domain",
  "region",
  "market",
  "check",
  "game",
  "status",
  "duration_s",
  "headline",
  "what_happened",
  "verdict",
  "technical_error",
];

const localFmt = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Asia/Manila",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

type Row = {
  id: string;
  brand: string;
  region: string;
  checkName: string;
  status: string;
  durationMs: number;
  error: string | null;
  target: string | null;
  startedAt: Date;
};

function toCsvLine(r: Row): string {
  const blocked = r.status === "fail" && isBlockedError(r.error);
  const x = r.status === "fail" ? explainFailure(r.error) : null;
  return [
    localFmt.format(r.startedAt),
    r.startedAt.toISOString(),
    SITE_DOMAINS[r.brand as Brand] ?? r.brand,
    r.region,
    COLUMNS.find((c) => c.region === r.region)?.label ?? "",
    CHECK_LABELS[r.checkName] ?? r.checkName,
    gameName(r.target) ?? "",
    blocked ? "blocked" : r.status,
    (r.durationMs / 1000).toFixed(1),
    x?.headline ?? "",
    x?.detail ?? "",
    x ? VERDICT_LABELS[x.verdict] : "",
    x?.technical ?? "",
  ]
    .map(cell)
    .join(",");
}

function filename(f: RunsFilter): string {
  const parts = ["qa-runs", f.from ?? "start", f.to ?? "now"];
  if (f.status !== "all") parts.push(f.status);
  if (f.domain) parts.push(f.domain);
  if (f.region) parts.push(f.region);
  if (f.check) parts.push(f.check);
  return `${parts.join("_")}.csv`;
}

export async function GET(req: Request) {
  if (rateLimited(clientIp(req))) {
    return NextResponse.json(
      { error: "Too many exports — wait a minute and try again." },
      { status: 429, headers: { "retry-after": "60" } },
    );
  }

  const url = new URL(req.url);
  const parsed = parseRunsFilter(Object.fromEntries(url.searchParams));
  if (!parsed.ok) {
    return NextResponse.json({ error: `Invalid filter: ${parsed.error}` }, { status: 400 });
  }
  const filter = parsed.filter;
  const where = toWhere(filter);

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        // BOM: without it Excel opens UTF-8 as a legacy codepage and mangles
        // the arrows, accents and dashes in error text.
        controller.enqueue(encoder.encode("﻿" + HEADER.map(cell).join(",") + "\r\n"));

        let cursor: string | undefined;
        let sent = 0;
        while (sent < MAX_ROWS) {
          const rows: Row[] = await prisma.checkRun.findMany({
            where,
            orderBy: [{ startedAt: "desc" }, { id: "desc" }],
            take: Math.min(BATCH, MAX_ROWS - sent),
            ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
            select: {
              id: true,
              brand: true,
              region: true,
              checkName: true,
              status: true,
              durationMs: true,
              error: true,
              target: true,
              startedAt: true,
            },
          });
          if (rows.length === 0) break;
          controller.enqueue(encoder.encode(rows.map(toCsvLine).join("\r\n") + "\r\n"));
          sent += rows.length;
          cursor = rows[rows.length - 1]!.id;
          if (rows.length < BATCH) break;
        }
        controller.close();
      } catch (e) {
        console.error("[export] failed mid-stream:", e);
        controller.error(e);
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${filename(filter)}"`,
      "cache-control": "no-store",
    },
  });
}
