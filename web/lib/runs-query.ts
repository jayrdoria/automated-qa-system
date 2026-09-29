import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { BRANDS, CHECKS, COLUMNS } from "./checks";

/**
 * One filter definition for the Recent runs table AND the CSV export.
 *
 * Shared on purpose: "what you see is what you download". If the two parsed
 * query strings separately, an export would eventually disagree with the table
 * it was taken from, and nobody would notice until it mattered.
 */

/** Dates are calendar days in the team's timezone, not UTC. */
export const TZ_OFFSET = "+08:00";

/**
 * cleanup.sh keeps the current and previous calendar month, so nothing older
 * than ~62 days exists. The cap is slightly above that so a full-retention
 * export is always possible, while rejecting a mistyped year.
 */
export const MAX_RANGE_DAYS = 93;

export const RUN_STATUSES = ["all", "fail", "pass", "blocked"] as const;
export type RunStatusFilter = (typeof RUN_STATUSES)[number];

export const STATUS_FILTER_LABELS: Record<RunStatusFilter, string> = {
  all: "All",
  fail: "Failures only",
  pass: "Passes only",
  blocked: "Blocked only",
};

/** An empty form field arrives as "" — treat it as "not set". */
const blank = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);

/**
 * A real calendar day. Date.parse alone is not enough: V8 accepts any day up to
 * 31 regardless of month and rolls it over, so "2026-02-30" silently became
 * March 2nd. Round-tripping through UTC components catches that.
 */
function isRealDay(s: string): boolean {
  const [y, m, d] = s.split("-").map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "dates must be YYYY-MM-DD")
  .refine(isRealDay, "not a real date");

const REGION_IDS = COLUMNS.map((c) => c.region) as [string, ...string[]];
const CHECK_IDS = CHECKS.map((c) => c.id) as [string, ...string[]];

export const runsFilterSchema = z
  .object({
    from: z.preprocess(blank, day.optional()),
    to: z.preprocess(blank, day.optional()),
    status: z.preprocess(blank, z.enum(RUN_STATUSES).default("all")),
    domain: z.preprocess(blank, z.enum(BRANDS).optional()),
    region: z.preprocess(blank, z.enum(REGION_IDS).optional()),
    check: z.preprocess(blank, z.enum(CHECK_IDS).optional()),
  })
  .superRefine((f, ctx) => {
    if (f.from && f.to && f.from > f.to) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "'from' is after 'to'", path: ["from"] });
    }
    if (f.from && f.to) {
      const days = (dayStart(f.to).getTime() - dayStart(f.from).getTime()) / 86_400_000 + 1;
      if (days > MAX_RANGE_DAYS) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `range is ${days} days — at most ${MAX_RANGE_DAYS} (older data is pruned anyway)`,
          path: ["to"],
        });
      }
    }
  });

export type RunsFilter = z.infer<typeof runsFilterSchema>;

export const FILTER_KEYS = ["from", "to", "status", "domain", "region", "check"] as const;

/** Parse whatever arrived in the query string. Unknown keys are ignored. */
export function parseRunsFilter(
  raw: Record<string, string | string[] | undefined>,
): { ok: true; filter: RunsFilter } | { ok: false; error: string; filter: RunsFilter } {
  const picked: Record<string, string | undefined> = {};
  for (const k of FILTER_KEYS) {
    const v = raw[k];
    picked[k] = Array.isArray(v) ? v[0] : v;
  }
  const parsed = runsFilterSchema.safeParse(picked);
  if (parsed.success) return { ok: true, filter: parsed.data };
  return {
    ok: false,
    error: parsed.error.issues.map((i) => `${i.path.join(".") || "filter"}: ${i.message}`).join("; "),
    filter: { status: "all" },
  };
}

/** 00:00 of a calendar day in the team's timezone. */
export function dayStart(d: string): Date {
  return new Date(`${d}T00:00:00${TZ_OFFSET}`);
}

/** Exclusive upper bound: 00:00 of the following day, so "to" includes all of its day. */
export function dayEnd(d: string): Date {
  return new Date(dayStart(d).getTime() + 86_400_000);
}

const BLOCKED_MARKER = "EDGE_BLOCKED";

/**
 * Blocked runs are stored as status "fail" (the runner could not tell them
 * apart at the time). "Failures only" means REAL failures, so they are split
 * out — a Cloudflare refusal of the VPN exit says nothing about the site.
 */
export function toWhere(f: RunsFilter): Prisma.CheckRunWhereInput {
  const and: Prisma.CheckRunWhereInput[] = [];

  if (f.from) and.push({ startedAt: { gte: dayStart(f.from) } });
  if (f.to) and.push({ startedAt: { lt: dayEnd(f.to) } });
  if (f.domain) and.push({ brand: f.domain });
  if (f.region) and.push({ region: f.region });
  if (f.check) and.push({ checkName: f.check });

  switch (f.status) {
    case "pass":
      and.push({ status: "pass" });
      break;
    case "blocked":
      and.push({ status: "fail", error: { contains: BLOCKED_MARKER } });
      break;
    case "fail":
      // `NOT contains` alone would drop failures whose error is NULL, because
      // NOT (NULL LIKE …) is NULL in SQL, not true.
      and.push({
        status: "fail",
        OR: [{ error: null }, { NOT: { error: { contains: BLOCKED_MARKER } } }],
      });
      break;
    case "all":
      break;
  }

  return and.length ? { AND: and } : {};
}

/** Query string for the given filter, with optional overrides (e.g. page). */
export function filterQuery(f: RunsFilter, extra: Record<string, string | number> = {}): string {
  const p = new URLSearchParams();
  for (const k of FILTER_KEYS) {
    const v = f[k];
    if (v && !(k === "status" && v === "all")) p.set(k, String(v));
  }
  for (const [k, v] of Object.entries(extra)) p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : "?";
}

export function isFiltered(f: RunsFilter): boolean {
  return FILTER_KEYS.some((k) => f[k] && !(k === "status" && f[k] === "all"));
}
