/**
 * Games the game-load check rotates through.
 *
 * ⚠ MUST MATCH `GAMES` in web/lib/checks.ts (ids and names). The dashboard and
 * alert emails look games up by id; an id here that the web side does not know
 * still records and alerts, but shows as a raw id instead of a name.
 */
export interface GameTarget {
  /** Stable id — stored in check_run.target and used in alert keys. */
  id: string;
  /** Display name, as the site titles the page ("Game: Multifly"). */
  name: string;
  /** Path segment under /game/…/real, shared by every Stakes mirror. */
  path: string;
  /**
   * The provider's own numeric game id, carried in the game frame's URL
   * (…launcher?gameid=1114…). Measured on the live site. Language-independent
   * and identical across mirrors, so it proves WHICH game loaded without
   * depending on a translated page title. Undefined skips that assertion.
   */
  providerGameId?: string;
  /**
   * Same purpose as providerGameId, for platforms that carry the game's
   * identity as a named query parameter instead. X7's frame is a wrapper
   * (games-static…/game-wrapper/index.html?…&game_name=Gates of Olympus 2500
   * &provider=pragmatic…) whose game_name is the untranslated English name on
   * every locale — measured on /fr. Undefined skips that assertion.
   */
  frameParam?: { key: string; value: string };
}

export const STAKES_GAMES: GameTarget[] = [
  {
    id: "wanted-dead-or-a-wild",
    name: "Wanted Dead or a Wild",
    path: "hacksaw/wanted-dead-or-a-wild",
    providerGameId: "1114",
  },
  { id: "multifly", name: "Multifly", path: "yggdrasil/multifly", providerGameId: "10122" },
  { id: "ze-zeus", name: "Ze Zeus", path: "hacksaw/ze-zeus", providerGameId: "1509" },
];

/**
 * X7 Casino's rotation. `path` is `<provider>/<slug>` under /<locale>/casino/,
 * slug prefixes (0z-, x2-, t3-) included — they are part of the live URL.
 *
 * The id "wanted-dead-or-a-wild" is shared with STAKES_GAMES on purpose: same
 * game, same display name, and results are already separated by brand.
 */
export const X7_GAMES: GameTarget[] = [
  {
    id: "wanted-dead-or-a-wild",
    name: "Wanted Dead or a Wild",
    path: "hacksaw/0z-wanted-dead-or-a-wild",
    frameParam: { key: "game_name", value: "Wanted Dead or a Wild" },
  },
  {
    id: "gates-of-olympus-2500",
    name: "Gates of Olympus 2500",
    path: "pragmaticplay/x2-gates-of-olympus-2500",
    frameParam: { key: "game_name", value: "Gates of Olympus 2500" },
  },
  {
    id: "bavarian-riches-3",
    name: "Bavarian Riches 3",
    path: "spinomenal/t3-bavarian-riches-3",
    frameParam: { key: "game_name", value: "Bavarian Riches 3" },
  },
];

/**
 * Must match RUN_INTERVAL_MIN (web/lib/checks.ts) / MIN_INTERVAL_MIN
 * (scripts/run-checks.sh). Only used to size rotation slots: if it drifts, the
 * rotation still covers every game, it just stops being one-game-per-run.
 */
const ROTATION_SLOT_MIN = 25;

/**
 * The rotation is keyed to when the RUN started, not when this attempt started.
 *
 * Playwright restarts the worker after a failure, so a retry re-evaluates
 * everything. Keyed to Date.now(), a retry that crossed a slot boundary would
 * test a different game — and a Multifly failure followed by a passing Ze Zeus
 * retry would be recorded as a pass. playwright.config.ts stamps this once in
 * the main process; workers inherit it.
 */
function runStartedAt(): number {
  const stamped = Number(process.env.QA_RUN_STARTED_AT);
  return Number.isFinite(stamped) && stamped > 0 ? stamped : Date.now();
}

/**
 * Which game this run tests.
 *
 * Deterministic from the clock rather than random, so a failure can be
 * reproduced ("the 14:20 FR run tested Multifly") and coverage is guaranteed:
 * with a 25-minute interval each column cycles through all three games every
 * 75 minutes. Offsetting by the column's index means that at any moment the columns
 * are testing DIFFERENT games — a broken game shows up somewhere within one
 * cycle instead of waiting for every column to reach it together.
 *
 * GAME_OVERRIDE pins a game by id for manual debugging:
 *   GAME_OVERRIDE=multifly npx playwright test tests/checks/3-game-load.spec.ts
 */
export function pickGame(
  games: GameTarget[],
  columnIndex: number,
  now: number = runStartedAt(),
): GameTarget {
  if (games.length === 0) throw new Error("pickGame: no games configured for this brand");

  const override = process.env.GAME_OVERRIDE?.trim();
  if (override) {
    const pinned = games.find((g) => g.id === override);
    if (!pinned) {
      throw new Error(
        `GAME_OVERRIDE="${override}" is not a configured game (have: ${games.map((g) => g.id).join(", ")})`,
      );
    }
    return pinned;
  }

  const slot = Math.floor(now / (ROTATION_SLOT_MIN * 60_000));
  const index = (((slot + Math.max(0, columnIndex)) % games.length) + games.length) % games.length;
  return games[index]!;
}
