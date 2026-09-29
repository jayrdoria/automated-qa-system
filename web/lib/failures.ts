/**
 * Turns a raw Playwright failure into something a person can act on.
 *
 * The raw text is written for whoever is debugging a selector — "locator.click:
 * Timeout 15000ms exceeded. Call log: - waiting for …" — and it was being
 * forwarded verbatim into Slack and the dashboard. This module answers the three
 * questions an on-call reader actually has: what broke, is it probably real, and
 * what does it mean.
 *
 * Derived at render time from the stored error string, never persisted, so it
 * applies to every historical row without a migration and improves the moment a
 * rule is added. The rules below were built against every failure the
 * production dashboard had recorded (370 over 14 days) — keep that coverage in
 * mind before loosening a pattern.
 *
 * Deliberately dependency-free: the dashboard, the alert emails and the CSV
 * export all import it, and it is compiled standalone for its own tests.
 */

export type Verdict = "site" | "flaky" | "network" | "blocked" | "unknown";

export interface Explanation {
  /** One line, plain English, no jargon. Safe to use as an email subject tail. */
  headline: string;
  /** What happened and the likely cause, in a sentence or two. */
  detail: string;
  verdict: Verdict;
  /** The original error with terminal colour codes removed, for debugging. */
  technical: string;
}

export const VERDICT_LABELS: Record<Verdict, string> = {
  site: "Likely a real site problem",
  flaky: "Likely a monitoring glitch, not the site",
  network: "Slow network or VPN",
  blocked: "Blocked before reaching the site",
  unknown: "Unclassified",
};

/**
 * Playwright colours its assertion output with ANSI escapes. The previous
 * cleaner removed "[31m" but left the ESC byte in front of it, which is the
 * "" box that showed up in the dashboard. Strips both the full sequences
 * and any orphaned remnants whose ESC was already lost.
 */
export function stripAnsi(text: string): string {
  return (
    text
      // eslint-disable-next-line no-control-regex
      .replace(/\u001b\[[0-9;]*[A-Za-z]/g, "")
      // eslint-disable-next-line no-control-regex
      .replace(/\u001b/g, "")
      .replace(/\[(?:\d{1,3}(?:;\d{1,3})*)?m/g, "")
  );
}

/** Collapse whitespace so multi-line Playwright output reads as one paragraph. */
function normalise(text: string): string {
  return stripAnsi(text).replace(/\s+/g, " ").trim();
}

/** Drop the "Stakes.com: " prefix the specs add — the domain is shown elsewhere. */
function withoutBrand(line: string): string {
  return line.replace(/^(Error:\s*)?[A-Za-z0-9. ]+?\.com:\s*/, "").replace(/^Error:\s*/, "");
}

const seconds = (ms: string) => `${Math.round(Number(ms) / 1000)}s`;

interface Rule {
  test: RegExp;
  explain: (m: RegExpMatchArray) => Omit<Explanation, "technical">;
}

/*
 * Order matters: the first match wins, so specific causes sit above the generic
 * timeouts they also contain (a cashier-backdrop interception IS a click
 * timeout, but saying so hides the actual reason).
 */
const RULES: Rule[] = [
  {
    test: /EDGE_BLOCKED: \S+ returned (\d{3})/,
    explain: (m) => ({
      headline: "Blocked by Cloudflare before reaching the site",
      detail:
        `Cloudflare refused the request (HTTP ${m[1]}), so the site itself was never tested. ` +
        "Usually the VPN exit's IP address was flagged; the next run normally gets through.",
      verdict: "blocked",
    }),
  },
  {
    test: /experience-cashier-bg[\s\S]*intercepts pointer events/,
    explain: () => ({
      headline: "Cashier opened on its own before the Deposit click",
      detail:
        "The first-deposit prompt appeared by itself and covered the Deposit button, so the " +
        "click could not land. The cashier was working — this was a timing race in the check.",
      verdict: "flaky",
    }),
  },
  {
    test: /bad credentials produced a logged-in session/,
    explain: () => ({
      headline: "A wrong password was accepted",
      detail:
        "The check signed in with a deliberately wrong password and the site treated it as " +
        "logged in. If this is real it is a security problem — verify it manually.",
      verdict: "site",
    }),
  },
  {
    test: /still showing the login control after sign-in/,
    explain: () => ({
      headline: "Login did not complete",
      detail:
        "Valid credentials were submitted but the Login button was still showing 30 seconds " +
        "later. Either the account was rejected or signing in was extremely slow.",
      verdict: "site",
    }),
  },
  {
    test: /homepage returned (\d{3})/,
    explain: (m) => ({
      headline: `Homepage returned an HTTP ${m[1]} error`,
      detail: `The homepage answered with status ${m[1]} instead of loading normally.`,
      verdict: "site",
    }),
  },
  {
    test: /homepage served an error page \("([^"]*)"\)/,
    explain: (m) => ({
      headline: "Homepage showed an error page",
      detail: `The homepage loaded, but its title was "${m[1]}" — an error or maintenance page.`,
      verdict: "site",
    }),
  },
  {
    test: /homepage (has an empty title|body is effectively empty)/,
    explain: () => ({
      headline: "Homepage loaded blank",
      detail:
        "The homepage responded but rendered nothing. Usually the site was down, mid-deploy, " +
        "or showing a challenge page instead of the casino.",
      verdict: "site",
    }),
  },
  {
    test: /(?:loaded the wrong game|redirected away from the game)[^\n]*?(?:expected|asked for) "?([^".]+)"?/i,
    explain: (m) => ({
      headline: `The wrong page loaded instead of ${m[1]}`,
      detail:
        `The check asked for ${m[1]} but ended up somewhere else — typically the lobby, ` +
        "because the game was removed, renamed or is unavailable in this market.",
      verdict: "site",
    }),
  },
  {
    test: /game iframe never appeared/,
    explain: () => ({
      headline: "The game did not load",
      detail: "The game page opened but the game frame never appeared.",
      verdict: "site",
    }),
  },
  {
    test: /game iframe (collapsed|has no layout box)/,
    explain: () => ({
      headline: "The game frame loaded empty",
      detail:
        "The game frame was on the page but had no size — it mounted without the game " +
        "actually starting.",
      verdict: "site",
    }),
  },
  {
    test: /cashier modal did not open/,
    explain: () => ({
      headline: "Cashier did not open",
      detail: "The Deposit button was clicked while logged in, but the cashier never appeared.",
      verdict: "site",
    }),
  },
  {
    test: /deposit button not found/,
    explain: () => ({
      headline: "Deposit button missing while logged in",
      detail:
        "The account was signed in but no Deposit button was visible. The header may have " +
        "changed, or the session did not fully load.",
      verdict: "site",
    }),
  },
  {
    test: /provider panel opened but stayed empty/,
    explain: () => ({
      headline: "Provider list was empty",
      detail: "The Providers panel opened but listed no providers.",
      verdict: "site",
    }),
  },
  {
    test: /chat widget never mounted/,
    explain: () => ({
      headline: "Live chat icon never appeared",
      detail:
        "The Zoho live-chat icon did not show within 45 seconds. Zoho may be down or slow, or " +
        "its script failed to load.",
      verdict: "site",
    }),
  },
  {
    test: /chat widget has no layout box/,
    explain: () => ({
      headline: "Live chat icon loaded without a size",
      detail: "The chat widget element exists but is not being drawn on the page.",
      verdict: "site",
    }),
  },
  {
    test: /Test timeout of (\d+)ms exceeded/,
    explain: (m) => ({
      headline: `The check ran out of time (${seconds(m[1])})`,
      detail:
        `The whole check took longer than its ${seconds(m[1])} limit, usually because a page or ` +
        "the VPN was very slow. Older runs did not record which step stalled; newer runs do.",
      verdict: "network",
    }),
  },
  {
    test: /page\.goto: Timeout (\d+)ms exceeded[\s\S]*?navigating to "([^"]+)"/,
    explain: (m) => ({
      headline: `A page did not load within ${seconds(m[1])}`,
      detail:
        `${m[2]} did not finish loading in time. Usually slow VPN routing or a slow site ` +
        "rather than an outage.",
      verdict: "network",
    }),
  },
  {
    test: /page\.goto: Timeout (\d+)ms exceeded/,
    explain: (m) => ({
      headline: `A page did not load within ${seconds(m[1])}`,
      detail: "The page did not finish loading in time — usually slow VPN routing or a slow site.",
      verdict: "network",
    }),
  },
  {
    // Waiting for the header login trigger. The regex source is embedded in the
    // error text, which is what makes this identifiable.
    test: /waitFor: Timeout (\d+)ms[\s\S]*?\(connexion\|/,
    explain: (m) => ({
      headline: "The Login button never appeared",
      detail:
        `The page loaded but no Login button showed within ${seconds(m[1])} — the site did not ` +
        "render its header. Usually the site was down or serving a challenge page.",
      verdict: "site",
    }),
  },
  {
    test: /waitFor: Timeout (\d+)ms[\s\S]*?\(providers\|/,
    explain: (m) => ({
      headline: "The Providers button never appeared",
      detail: `The casino page loaded but its Providers button did not show within ${seconds(m[1])}.`,
      verdict: "site",
    }),
  },
  {
    test: /waitFor: Timeout (\d+)ms[\s\S]*?getByPlaceholder/,
    explain: (m) => ({
      headline: "The login form did not open",
      detail: `The Login button was clicked but the form did not appear within ${seconds(m[1])}.`,
      verdict: "site",
    }),
  },
  {
    test: /net::(ERR_[A-Z_]+)/,
    explain: (m) => ({
      headline: `Network error (${m[1]})`,
      detail:
        "The browser could not reach the site at the network level — typically the VPN tunnel " +
        "dropped or DNS failed, not the site itself.",
      verdict: "network",
    }),
  },
  {
    test: /Target (?:page, context or browser has been )?closed|browser has been closed|socket hang up|ECONNRESET|ECONNREFUSED/i,
    explain: () => ({
      headline: "The browser or connection closed unexpectedly",
      detail:
        "The test browser lost its connection mid-check. This is almost always a monitoring " +
        "environment problem rather than the site.",
      verdict: "flaky",
    }),
  },
  {
    test: /intercepts pointer events/,
    explain: () => ({
      headline: "A popup covered the button being clicked",
      detail:
        "Something was on top of the element the check tried to click — usually a promotion " +
        "popup or overlay that appeared at the wrong moment.",
      verdict: "flaky",
    }),
  },
  {
    test: /locator\.click: Timeout (\d+)ms/,
    explain: (m) => ({
      headline: "A button could not be clicked",
      detail: `The check found the button but could not click it within ${seconds(m[1])}.`,
      verdict: "flaky",
    }),
  },
];

const TECHNICAL_MAX = 4000;

export function explainFailure(error: string | null | undefined): Explanation {
  if (!error || !error.trim()) {
    return {
      headline: "Failed without an error message",
      detail: "The check failed but did not record why.",
      verdict: "unknown",
      technical: "",
    };
  }

  const technical = normalise(error).slice(0, TECHNICAL_MAX);

  for (const rule of RULES) {
    const m = technical.match(rule.test);
    if (m) return { ...rule.explain(m), technical };
  }

  // Unrecognised: the first sentence of the raw message is still better than
  // nothing, and it is exactly what a new rule should be written against.
  const first = withoutBrand(technical.split(/(?<=\.)\s|\s(?:Call log:|expect\()/)[0] ?? technical);
  return {
    headline: first.slice(0, 140),
    detail: "This failure did not match a known pattern — see the technical details.",
    verdict: "unknown",
    technical,
  };
}

/** Blocked results are evidence about the route, not the site. */
export function isBlockedError(error: string | null | undefined): boolean {
  return !!error && error.includes("EDGE_BLOCKED");
}
