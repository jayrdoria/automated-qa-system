import { z } from "zod";

/**
 * An empty value in .env arrives as "" rather than undefined, so a bare
 * .default() never fires and .url() rejects it. Every optional URL needs this.
 */
const blankToUndefined = (v: unknown) =>
  typeof v === "string" && v.trim() === "" ? undefined : v;

const schema = z.object({
  STAKES_BASE_URL: z.string().url(),
  STAKES_USERNAME: z.string().min(1),
  STAKES_PASSWORD: z.string().min(1),

  /**
   * Mirror domains — the same application on a different host.
   *
   * Base URLs default to the canonical host, so .env only needs to carry them
   * when a host changes. If a gate run shows an unexpected redirect, setting
   * the variable is a one-line fix with no redeploy.
   */
  STAKES3_BASE_URL: z.preprocess(
    blankToUndefined,
    z.string().url().default("https://stakes3.com"),
  ),
  STAKESCASINO_BASE_URL: z.preprocess(
    blankToUndefined,
    z.string().url().default("https://stakescasino.com"),
  ),

  /*
   * Credentials are optional HERE and required at the point of use — see
   * requireCredential() in brands.ts.
   *
   * getConfig() validates the whole schema at once, so marking these .min(1)
   * would make a missing STAKES3_PASSWORD fail the DE, ES and BD runs too,
   * which do not use it. Validating per-site keeps the blast radius to the one
   * domain that actually needs the key, and still fails loudly rather than
   * falling back to another account — a fallback would either redden a healthy
   * site or silently pass while testing the wrong login.
   */
  STAKES3_USERNAME: z.string().default(""),
  STAKES3_PASSWORD: z.string().default(""),
  STAKESCASINO_USERNAME: z.string().default(""),
  STAKESCASINO_PASSWORD: z.string().default(""),

  // Optional while X7 is deferred — the checks are skipped, so demanding
  // credentials would block the whole suite on an unusable brand.
  X7_BASE_URL: z.string().url().default("https://x7casino.com"),
  X7_USERNAME: z.string().default(""),
  X7_PASSWORD: z.string().default(""),

  /// Where the runner POSTs results. Set by compose to the in-network web URL
  /// so results still land if the public vhost is down.
  INGEST_URL: z.preprocess(
    blankToUndefined,
    z.string().url().default("http://web:7071/automated-qa-system/api/results"),
  ),
  INGEST_TOKEN: z.string().min(32),

  /// Which market this run represents. The VPN exit country decides what the
  /// brands actually serve, so the runner is TOLD its region rather than
  /// guessing — one run per region, tagged on the way in. The region also
  /// selects WHICH DOMAIN is tested; see COLUMNS in brands.ts.
  CHECK_REGION: z
    .string()
    .regex(/^[A-Z]{2}$/, "CHECK_REGION must be a 2-letter country code")
    .default("FR"),

  /**
   * Reserved. X7 has no column in COLUMNS, so it cannot be selected by any
   * region and this flag currently gates nothing. Kept so its credentials and
   * selectors stay wired up for the day its Cloudflare challenge is lifted.
   */
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
