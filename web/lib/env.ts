import { z } from "zod";

const schema = z.object({
  DATABASE_URL: z.string().url(),
  /// Shared secret the runner presents when POSTing results. The ingest route
  /// is reachable through Apache like every other path under the basePath,
  /// so it cannot rely on network isolation alone.
  INGEST_TOKEN: z.string().min(32, "INGEST_TOKEN must be at least 32 chars"),
  /// Off by default: failure screenshots capture logged-in casino account
  /// state and this dashboard is unauthenticated.
  PUBLIC_SHOW_SCREENSHOTS: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),

  // Alerting. Optional so the system records results before SMTP is set up —
  // an unconfigured notifier logs and drops rather than throwing.
  SMTP_HOST: z.string().optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  ALERT_TO: z.string().optional(),
  // Empty string in .env would coerce to 0 and fail .positive(), taking the
  // whole ingest route down. Treat blank as "unset".
  ALERT_RENOTIFY_HOURS: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.coerce.number().positive().default(4),
  ),
});

type Env = z.infer<typeof schema>;

let cached: Env | undefined;

/**
 * Validated lazily on first use, not at module load.
 *
 * `next build` imports every route module to collect them, and at that point
 * no real env exists — a module-level throw here would break the Docker build
 * rather than surfacing a genuine misconfiguration at runtime.
 */
export function getEnv(): Env {
  if (cached) return cached;

  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(
      `Invalid environment:\n${parsed.error.issues
        .map((i) => `  ${i.path.join(".")}: ${i.message}`)
        .join("\n")}`,
    );
  }

  cached = parsed.data;
  return cached;
}
