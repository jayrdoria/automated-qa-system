import { test, expect } from "@playwright/test";
import { BRAND_IDS, activeBrands, columnIndex, getBrand } from "../../lib/brands";
import { getConfig } from "../../lib/config";
import { pickGame } from "../../lib/games";
import { loginAndVerify } from "../../lib/login";
import { gotoChecked } from "../../lib/preflight";

// Exactly ONE domain runs per invocation: activeBrands() resolves CHECK_REGION
// (+ CHECK_SITE) to its column (FR/IT -> stakes3, DE/ES -> stakes,
// BD -> stakescasino, FR/DE/IT + x7 -> x7casino2.com) and the rest skip. The describe-block title stays equal to the brand id, which is
// what the reporter files results under.
for (const id of BRAND_IDS) {
  const enabled = () => activeBrands().includes(id);
  test.describe(id, () => {
    test.skip(() => !enabled(), "not the domain for this CHECK_REGION");
    // Real-play mode needs a session, so this check subsumes login.
    test("game-load", async ({ page }, testInfo) => {
      const brand = getBrand(id);
      const region = getConfig().CHECK_REGION;
      const game = pickGame(brand.games, columnIndex(region, id));

      /*
       * Recorded as an annotation BEFORE anything can fail, so the reporter can
       * file the result under this game whether it passes or not. Without it a
       * broken Multifly and a broken Ze Zeus would be indistinguishable, and
       * per-game alerting could not exist.
       */
      testInfo.annotations.push({ type: "target", description: game.id });
      console.log(`[game-load] ${brand.label} ${region}: testing ${game.name}`);

      await loginAndVerify(page, brand);

      // Brands that can say WHY a launch failed (X7's launch API) record it
      // here; the frame assertion below reports it instead of a bare timeout.
      const refusals: string[] = [];
      const inspect = brand.gameLaunchRefusal;
      if (inspect) {
        page.on("response", (res) => {
          void inspect(res)
            .then((reason) => {
              if (reason) refusals.push(reason);
            })
            .catch(() => {});
        });
      }

      await gotoChecked(page, brand.gameUrl(game));

      // A removed or unavailable game can bounce back to the lobby with a 200.
      // Without this the next assertion would find the lobby's own iframes.
      expect(
        page.url(),
        `${brand.label}: redirected away from the game — asked for "${game.name}", landed on ${page.url()}`,
      ).toContain(brand.gameUrlFragment(game));

      const frame = brand.gameFrame(page);
      try {
        await expect(
          frame,
          `${brand.label}: game iframe never appeared (${game.name})`,
        ).toBeVisible({ timeout: 45_000 });
      } catch (e) {
        if (refusals.length === 0) throw e;
        throw new Error(
          `${brand.label}: game launch refused by the site (${refusals[0]}) — ${game.name}. ` +
            `Login worked; the platform declined to start the game for the test account.`,
        );
      }

      // Visible-but-collapsed is the common silent failure: the iframe mounts,
      // the game never boots, and a naive visibility assertion passes.
      const box = await frame.boundingBox();
      expect(box, `${brand.label}: game iframe has no layout box (${game.name})`).not.toBeNull();
      expect(
        box!.width,
        `${brand.label}: game iframe collapsed (width ${box!.width}, ${game.name})`,
      ).toBeGreaterThan(200);
      expect(
        box!.height,
        `${brand.label}: game iframe collapsed (height ${box!.height}, ${game.name})`,
      ).toBeGreaterThan(200);

      /*
       * Prove it is the RIGHT game. Before rotation any iframe passed, so the
       * check could not tell a working Multifly from a lobby banner. The frame
       * URL carries the provider's own numeric game id (gameid=10122), which is
       * language-independent and identical on every mirror — unlike the page
       * title, which is translated.
       */
      if (game.providerGameId) {
        const src = decodeURIComponent((await frame.getAttribute("src")) ?? "");
        expect(
          new RegExp(`[?&]gameid=${game.providerGameId}(?:&|$)`).test(src),
          `${brand.label}: loaded the wrong game — expected "${game.name}" (gameid ${game.providerGameId}), frame points at ${src.slice(0, 160) || "(no src)"}`,
        ).toBe(true);
      }

      // Same proof for platforms that name the game in a query parameter.
      // Parsed, not regex-matched: the value has spaces and is URL-encoded.
      if (game.frameParam) {
        const raw = (await frame.getAttribute("src")) ?? "";
        let actual: string | null = null;
        try {
          actual = new URL(raw, page.url()).searchParams.get(game.frameParam.key);
        } catch {
          actual = null;
        }
        expect(
          actual,
          `${brand.label}: loaded the wrong game — expected ${game.frameParam.key}="${game.frameParam.value}", frame has ${actual === null ? "no such parameter" : `"${actual}"`}`,
        ).toBe(game.frameParam.value);
      }
    });
  });
}
