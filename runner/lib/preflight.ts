import type { Page, Response } from "@playwright/test";

/**
 * The VPS is in Singapore; Stakes and X7 serve FR/DE/IT/ES and geo-block the
 * rest. Until 194.233.89.28 is whitelisted, every request returns a Cloudflare
 * 403 interstitial.
 *
 * Without this guard each of the 10 checks would fail on its own selector and
 * emit its own alert — 10 emails saying "login broken" when the real answer is
 * "we never reached the site". This turns that into one unambiguous signal.
 */

export class EdgeBlockedError extends Error {
  constructor(url: string, status: number, hint: string) {
    super(
      `EDGE_BLOCKED: ${url} returned ${status} (${hint}). ` +
        `The request never reached the application. Most likely the source IP ` +
        `is not whitelisted / is outside the permitted region — not a broken check.`,
    );
    this.name = "EdgeBlockedError";
  }
}

const BLOCK_TITLES =
  /attention required|just a moment|access denied|sorry, you have been blocked|forbidden/i;
const BLOCK_BODY =
  /you have been blocked|unable to access|not available in your (country|region)|geo.?restrict|cloudflare/i;

/**
 * Navigate and fail fast with a distinct error if we hit an edge block.
 * Returns the response for callers that want it.
 */
export async function gotoChecked(
  page: Page,
  url: string,
  timeout = 45_000,
): Promise<Response | null> {
  const res = await page.goto(url, { waitUntil: "domcontentloaded", timeout });
  const status = res?.status() ?? 0;

  if (status === 403 || status === 503 || status === 429) {
    const title = await page.title().catch(() => "");
    const body = await page
      .locator("body")
      .innerText()
      .catch(() => "");
    if (BLOCK_TITLES.test(title) || BLOCK_BODY.test(body)) {
      throw new EdgeBlockedError(url, status, title || "edge interstitial");
    }
    throw new EdgeBlockedError(url, status, "unexpected status before app load");
  }

  return res;
}

/** True when a thrown error was an edge block rather than a real check failure. */
export function isEdgeBlocked(error: unknown): boolean {
  return (
    error instanceof EdgeBlockedError ||
    (error instanceof Error && error.message.includes("EDGE_BLOCKED"))
  );
}
