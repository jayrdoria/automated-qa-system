/**
 * Groups one run's failures into incidents.
 *
 * The checks are not independent: game-load and the cashier need a working
 * login, and everything needs the site to be up. In production, the bulk of
 * the real incidents were exactly that — the site or its login broke, and
 * login, cashier and game-load all failed together in the same run. Reported
 * separately, one broken login looked like three broken features.
 *
 * So within a single run, only the HIGHEST failing link in each chain is an
 * incident (a "root"); anything that failed below it is a consequence and is
 * reported inside the root's alert instead of as its own. And when EVERY check
 * in a run fails, the site is down or in maintenance, whatever the individual
 * errors say.
 *
 * Pure and dependency-free: alerting and the dashboard use the same grouping,
 * so what the email says and what the failures panel shows cannot drift apart.
 */

/** check → the check it cannot pass without. Absent = depends on nothing. */
export const DEPENDS_ON: Record<string, string> = {
  login: "site-up",
  "login-rejects-bad-creds": "site-up",
  providers: "site-up",
  "chat-widget": "site-up",
  "game-load": "login", // real-play needs a session
  "cashier-modal": "login", // the Deposit button only exists when signed in
};

export interface RunItem {
  checkName: string;
  /** A real failure. Blocked results must be passed as NOT failed. */
  failed: boolean;
}

export interface Incident<T extends RunItem> {
  root: T;
  consequences: T[];
}

export interface GroupedRun<T extends RunItem> {
  incidents: Incident<T>[];
  /** Every check in the run failed — the site is down or in maintenance. */
  allFailed: boolean;
}

/** The highest failing ancestor of a check in this run, or null if none failed. */
function failingAncestor(check: string, failed: Set<string>): string | null {
  let top: string | null = null;
  const seen = new Set<string>();
  for (let p = DEPENDS_ON[check]; p && !seen.has(p); p = DEPENDS_ON[p]) {
    seen.add(p);
    if (failed.has(p)) top = p;
  }
  return top;
}

/** The check everything depends on. */
export const ROOT_CHECK = "site-up";

export function groupRun<T extends RunItem>(items: T[]): GroupedRun<T> {
  const failedItems = items.filter((i) => i.failed);
  const failed = new Set(failedItems.map((i) => i.checkName));

  /*
   * "Everything past the homepage failed" counts as down, even if site-up
   * itself passed: a maintenance page can return 200 with an innocuous title,
   * and then login, games, cashier, providers and chat all fail at once.
   */
  const dependents = items.filter((i) => i.checkName !== ROOT_CHECK);
  const allFailed = dependents.length >= 2 && dependents.every((i) => i.failed);
  if (allFailed) {
    const [primary, ...rest] = failedItems; // runner order: site-up first when it failed
    return { incidents: primary ? [{ root: primary, consequences: rest }] : [], allFailed };
  }

  const byRoot = new Map<string, Incident<T>>();
  for (const item of failedItems) {
    if (!failingAncestor(item.checkName, failed)) {
      byRoot.set(item.checkName, { root: item, consequences: [] });
    }
  }
  for (const item of failedItems) {
    const ancestor = failingAncestor(item.checkName, failed);
    if (ancestor) byRoot.get(ancestor)?.consequences.push(item);
  }

  return { incidents: [...byRoot.values()], allFailed: false };
}

/** Why the consequences failed, phrased for a reader. */
export function consequenceReason(rootCheck: string, allFailed: boolean): string {
  if (allFailed) return "Every check in this run failed, so the site is most likely down or in maintenance";
  if (rootCheck === ROOT_CHECK) return "Because the site itself was down";
  if (rootCheck === "login") return "Because login failed, the checks that need a signed-in session could not run";
  return "Because of this failure";
}
