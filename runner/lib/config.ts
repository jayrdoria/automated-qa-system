import { z } from "zod";

const schema = z.object({
  STAKES_BASE_URL: z.string().url(),
  STAKES_USERNAME: z.string().min(1),
  STAKES_PASSWORD: z.string().min(1),

  // Optional while X7 is deferred — the checks are skipped, so demanding
  // credentials would block the whole suite on an unusable brand.
  X7_BASE_URL: z.string().url().default("https://x7casino.com"),
  X7_USERNAME: z.string().default(""),
  X7_PASSWORD: z.string().default(""),

  /// Where the runner POSTs results. Set by compose to the in-network web URL
  /// so results still land if the public vhost is down.
  // preprocess: an empty value in .env arrives as "" not undefined, so a bare
  // .default() would never fire and .url() would reject it.
  INGEST_URL: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.string().url().default("http://web:7071/automated-qa-system/api/results"),
  ),
  INGEST_TOKEN: z.string().min(32),

  /// Which markets this run represents. The VPN exit country decides what the
  /// brands actually serve, so the runner is TOLD its region rather than
  /// guessing — one run per region, tagged on the way in.
  CHECK_REGION: z
    .string()
    .regex(/^[A-Z]{2}$/, "CHECK_REGION must be a 2-letter country code")
    .default("FR"),

  /// X7 is deferred: still behind a Cloudflare interactive challenge that the
  /// VPN cannot clear. Set true once the whitelist lands.
  X7_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
});

export type RunnerConfig = z.infer<typeof schema>;

let cached: RunnerConfig | undefined;

/** Lazy so `playwright test --list` works without a populated .env. */
export function getConfig(): RunnerConfig {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(
      `Invalid runner environment:\n${parsed.error.issues
        .map((i) => `  ${i.path.join(".")}: ${i.message}`)
        .join("\n")}`,
    );
  }
  cached = parsed.data;
  return cached;
}
