import { expect, type Page, type Locator, type Response } from "@playwright/test";
import { getConfig, type RunnerConfig } from "./config";
import { STAKES_GAMES, X7_GAMES, type GameTarget } from "./games";

/**
 * ─────────────────────────────────────────────────────────────────────────
 *  THIS IS THE FILE YOU EDIT WHEN A SELECTOR BREAKS.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * Every brand-specific string lives here so the specs stay generic. When
 * Cloudflare whitelisting lands and the real DOM becomes visible, correcting
 * a check should mean changing a line in this file — never touching a spec.
 *
 * Selector strategy, in order of preference:
 *   1. getByTestId      — stable across redesigns, if the brand ships them
 *   2. getByRole + name — semantic, survives class churn
 *   3. placeholder/text — what we use now, derived from the login screenshot
 *   4. CSS classes      — last resort, breaks on every deploy
 *
 * Stakes selectors below come from the real login page. X7 selectors were
 * measured against the live x7casino2.com DOM through a FR exit.
 */

export type BrandId = "stakes" | "stakes3" | "stakescasino" | "x7";

/**
 * Which domain each market is tested against.
 *
 * ⚠ MUST MATCH `COLUMNS` in web/lib/checks.ts. The runner and the dashboard are
 * separate npm packages with separate tsconfigs, so this table is deliberately
 * duplicated rather than imported across the boundary. If they drift, the
 * runner files results under a brand the dashboard never renders and the cells
 * silently stay on "no data" while the checks pass.
 */
const COLUMNS: { region: string; site: BrandId }[] = [
  { region: "FR", site: "stakes3" },
  { region: "DE", site: "stakes" },
  { region: "IT", site: "stakes3" },
  { region: "ES", site: "stakes" },
  { region: "BD", site: "stakescasino" },
  // X7 shares the FR/DE/IT exits with Stakes. Appended, never interleaved: a
  // region's FIRST entry is its default site (see resolveSite), and the Stakes
  // columns' indices drive their game rotation — both must stay as they were.
  // No ES (geo-blocked) and no BD/EN column for X7.
  { region: "FR", site: "x7" },
  { region: "DE", site: "x7" },
  { region: "IT", site: "x7" },
];

/**
 * The domain a (region, site) pair tests.
 *
 * `site` omitted -> the region's FIRST column, which keeps every pre-X7 cron
 * line (`run-checks.sh FR`) testing exactly what it tested before.
 * `site` given   -> must be a real pair, e.g. FR+x7. DE+stakes3 is not.
 *
 * Returns undefined for anything unknown rather than defaulting to a site.
 * A typo'd CHECK_REGION/CHECK_SITE that silently tested the wrong domain and
 * filed the results under it would be far worse than a loud failure.
 */
export function resolveSite(region: string, site?: string): BrandId | undefined {
  const cols = COLUMNS.filter((c) => c.region === region);
  if (site === undefined) return cols[0]?.site;
  return cols.find((c) => c.site === site)?.site;
}

/** The domain THIS run is testing, from CHECK_REGION + CHECK_SITE. */
export function currentSite(): BrandId | undefined {
  const c = getConfig();
  return resolveSite(c.CHECK_REGION, c.CHECK_SITE);
}

/**
 * Position of a column in COLUMNS — offsets the game rotation per column.
 * Stakes columns resolve to the same indices (0-4) they always had.
 */
export function columnIndex(region: string, site: BrandId): number {
  return COLUMNS.findIndex((c) => c.region === region && c.site === site);
}

export interface BrandConfig {
  id: BrandId;
  label: string;
  baseUrl: string;
  username: string;
  password: string;

  /** Path to the casino/provider listing page. */
  casinoPath: string;
  /** Games game-load rotates through. See lib/games.ts. */
  games: GameTarget[];
  /** Real-play URL for one of this brand's games, on this brand's own host. */
  gameUrl: (game: GameTarget) => string;
  /**
   * What the page URL must still contain once the game page has loaded. A
   * removed game bounces back to the lobby with a 200, so this is what tells
   * "game page" from "lobby".
   */
  gameUrlFragment: (game: GameTarget) => string;

  /** Opens the login form. Stakes reveals an inline form; X7 opens a modal. */
  openLogin: (page: Page) => Promise<void>;
  /**
   * The header control that opens login. Its DISAPPEARANCE is how we verify a
   * session exists — verified on Stakes: after login the header swaps
   * "Connexion" for icon-only account controls carrying no text, so a positive
   * text-based marker is unreliable. Its absence is not.
   */
  loginTrigger: (page: Page) => Locator;
  usernameField: (page: Page) => Locator;
  passwordField: (page: Page) => Locator;
  submitLogin: (page: Page) => Locator;
  /** Present only when authenticated — used to assert login succeeded. */
  loggedInMarker: (page: Page) => Locator;
  /** Shown when credentials are rejected. */
  loginErrorMarker: (page: Page) => Locator;

  /**
   * The provider list is behind a "Providers" toggle on /casino — it is not
   * rendered until clicked. Asserting on the static page would always fail.
   */
  openProviders: (page: Page) => Promise<void>;
  providerTiles: (page: Page) => Locator;
  gameFrame: (page: Page) => Locator;
  chatWidget: (page: Page) => Locator;
  depositButton: (page: Page) => Locator;
  cashierModal: (page: Page) => Locator;
  /**
   * Optional: content that proves the cashier is usable, not just open.
   * Asserted non-empty after the modal is visible. Undefined skips it.
   */
  cashierContent?: (page: Page) => Locator;
  /** How long the chat widget may take to mount. Defaults to 45s. */
  chatTimeoutMs?: number;
  /**
   * Optional: waits after a verified login until the session survives a
   * navigation. Undefined (Stakes) means the session is usable as soon as the
   * login control disappears.
   */
  sessionReady?: (page: Page) => Promise<void>;
  /**
   * Optional: inspects responses while a game page loads and returns a short
   * reason when the platform REFUSED the launch (null otherwise). Lets the
   * failure say "the site refused" instead of the generic "iframe never
   * appeared". Undefined (Stakes) leaves game-load exactly as it was.
   */
  gameLaunchRefusal?: (response: Response) => Promise<string | null>;
}

/**
 * The brands localise by IP, and we deliberately check from four markets, so
 * every matcher must accept EN/FR/DE/IT/ES. Verified: an FR exit serves
 * "Connexion", a DE exit serves "Anmelden" — a French-only regex passed FR and
 * failed 4/7 checks on DE while the site was perfectly healthy.
 *
 * Neither brand exposes data-testid attributes, so these are text- and
 * structure-based by necessity.
 */
/**
 * `clickable` searches button/a/[role=button] AND requires visibility.
 *
 * Verified against the live site: Stakes keeps a hidden BUTTON "Se connecter"
 * in the DOM while the visible header control is "Connexion" on a different
 * element type. Searching only <button> matched the hidden one, so every click
 * timed out and read as "login broken".
 */
function clickable(page: Page, text: RegExp): Locator {
  // `div.btn` is load-bearing: Stakes renders its header controls as
  //   <div class="btn btn-lg btn-secondary">Connexion</div>
  // A bare <div> has no button role, so getByRole("button") returns 0 matches
  // and locator("button") finds only the hidden off-screen submit. Verified
  // against the live DOM.
  return page
    .locator(
      'button, a, div.btn, div.balance-deposit, [role="button"], input[type="submit"]',
    )
    .filter({ hasText: text })
    .filter({ visible: true });
}

const RE = {
  // Anchored, and deliberately excludes the submit-button wording: on several
  // locales the header trigger and the form submit share a word (FR
  // "Se connecter", DE "Anmelden"). Matching loosely clicks submit on an empty
  // form instead of opening the login panel.
  // Verified from live DOM per locale: FR "Connexion", DE "Anmelden",
  // ES "Inicia sesión" (imperative — NOT "Iniciar sesión"), IT "Accedi".
  login:
    /^(connexion|log\s?in|sign\s?in|anmelden|einloggen|accedi|inicia[r]? sesi[oó]n|acceder|entrar|ingresar)$/i,
  submit:
    /^(se connecter|sign\s?in|log\s?in|valider|envoyer|anmelden|einloggen|absenden|accedi|invia|acceder|inicia[r]? sesi[oó]n|entrar|enviar)$/i,
  loggedIn:
    /(deposit|d[ée]p[oô]t|caisse|einzahlung|kasse|konto|deposito|cassa|dep[oó]sito|caja|account|mon compte|profile|profil|logout|d[ée]connexion|abmelden|esci|salir)/i,
  // Verbs as well as nouns: DE uses "Einzahlen" (verb) where FR uses "Dépôt"
  // (noun). Matching only nouns passed FR/IT and failed DE's cashier check
  // while the button was right there.
  deposit:
    /^(deposit|deposita[r]?|d[ée]p[oô]ts?|d[ée]poser|caisse|einzahlung|einzahlen|kasse|cassa|dep[oó]sito|caja)$/i,
  providers:
    /^(providers|fournisseurs|anbieter|spielanbieter|fornitori|proveedores|proveedor)$/i,
  error:
    /(invalid|incorrect|wrong|failed|invalide|incorrecte?|erreur|échou|ung[üu]ltig|falsch|fehler|non valido|errato|errore|inv[aá]lido|incorrecto|error)/i,
  // Anchored: Stakes renders its registration form in the same DOM with
  // placeholders like "Indiquez votre adresse email". An unanchored match hits
  // those first and the login fields never get filled — which looks like a
  // broken login, not a bad selector.
  username:
    /^(identifiant|username|e-?mail|benutzername|nutzername|nome utente|utente|usuario|nombre de usuario)$/i,
  password: /^(mot de passe|password|passwort|kennwort|contrase[nñ]a|senha)$/i,
};

/**
 * Credentials are validated here, not in the config schema.
 *
 * getConfig() parses everything at once, so making STAKES3_PASSWORD required
 * there would break the DE, ES and BD runs, which never touch it. Checking at
 * the point of use keeps a missing key scoped to the one domain that needs it.
 *
 * There is deliberately NO fallback to another site's credentials. Falling back
 * either reddens a healthy site (the account does not exist there) or passes
 * while silently testing the wrong login — both worse than refusing to start.
 */
function requireCredential(value: string, envKey: string, domain: string): string {
  if (value.trim() === "") {
    throw new Error(
      `${envKey} is empty — it is required to test ${domain}. ` +
        `Set it in .env (use scripts/set-env.sh on the server). ` +
        `Credentials are never shared between mirror domains.`,
    );
  }
  return value;
}

/**
 * stakes.com, stakes3.com and stakescasino.com are the SAME application on
 * different hosts — verified against the live DOM on stakescasino.com: same
 * header markup (`div.btn.btn-secondary`), same `button.btn-login` submit, same
 * Zoho SalesIQ widget ids, same provider checkbox panel, same Hacksaw launcher
 * iframe. So they share one selector set and differ only by host and account.
 *
 * Keeping this a single factory is what guarantees the DE/ES path is unchanged:
 * stakesLike("stakes", ...) produces exactly the config that used to be
 * hand-written for Stakes.
 */
function stakesLike(
  id: BrandId,
  label: string,
  baseUrl: string,
  username: string,
  password: string,
  /**
   * Per-host corrections, applied last.
   *
   * Used sparingly and only where a host has been observed to differ. Keeping
   * them as an explicit override — rather than widening the shared selectors —
   * is what guarantees stakes.com and stakes3.com are unaffected: those two
   * cannot be exercised from a non-EU IP, so a change to the shared set could
   * not be verified before deploying it.
   */
  overrides: Partial<BrandConfig> = {},
): BrandConfig {
  return {
    id,
    label,
    baseUrl,
    username,
    password,
    casinoPath: "/casino",
    // Every Stakes mirror serves the same catalogue under the same paths, so the
    // URL is always built on THIS brand's host: stakes3 tests stakes3.com/game/…
    games: STAKES_GAMES,
    gameUrl: (game) => `${baseUrl}/game/${game.path}/real`,
    gameUrlFragment: (game) => `/game/${game.path}`,

    // getByRole cannot match this button — its accessible name differs from its
    // visible text (verified: getByRole returned 0 matches while the DOM shows
    // BUTTON "Se connecter"). Filter on text content instead.
    loginTrigger: (page) => clickable(page, RE.login),
    openLogin: async (page) => {
      const btn = clickable(page, RE.login).first();
      await btn.waitFor({ state: "visible", timeout: 15000 });
      await btn.click();
      // Form is present in the DOM but hidden until this click.
      await page.getByPlaceholder(RE.username).first().waitFor({ state: "visible", timeout: 15000 });
    },
    usernameField: (page) => page.getByPlaceholder(RE.username).first(),
    passwordField: (page) => page.getByPlaceholder(RE.password).first(),
    // Scoped to a real submit button so it cannot re-match the header div.
    submitLogin: (page) =>
      page
        .locator('button[type="submit"], button.btn-login')
        .filter({ hasText: RE.submit })
        .first(),
    // Once authenticated the Login button is replaced by account controls.
    loggedInMarker: (page) =>
      clickable(page, RE.loggedIn).first(),
    loginErrorMarker: (page) => page.getByText(RE.error).first(),

    openProviders: async (page) => {
      const toggle = clickable(page, RE.providers).first();
      await toggle.waitFor({ state: "visible", timeout: 20_000 });
      await toggle.click();
    },
    // The panel is a checkbox list (Amigo Gaming, AvatarUX, ...). The inputs
    // are custom-styled and therefore NOT "visible" to Playwright even when
    // the panel is open — filtering on visibility matched zero. Count the
    // inputs themselves; language-independent and restyle-proof.
    providerTiles: (page) => page.locator('.dropdown input[type="checkbox"], input[type="checkbox"]'),
    // Hotjar injects an iframe on the landing page, so scope to the game area
    // rather than taking the first iframe on the document.
    gameFrame: (page) =>
      page.locator('iframe[src*="game" i], iframe[allow*="fullscreen" i], main iframe').first(),
    // Zoho SalesIQ: <span id="zs_fl_chat" class="siqico-chat zsiq-chat-icn">
    // Confirmed from the live DOM (role=button, name "Chat Widget").
    /**
     * Zoho SalesIQ. #zsiq_float is the floating ICON container — the thing a
     * user actually sees bottom-right.
     *
     * Order matters and a broad [id^="zsiq_"] is wrong here: Zoho also mounts
     * #zsiq_chat_wrap (the collapsed chat WINDOW, permanently hidden until
     * opened). A broad match plus .first() selects that hidden element and the
     * check fails while the widget is visibly fine. #zsiqscript is likewise
     * excluded — the loader script exists whether or not anything renders.
     */
    chatWidget: (page) =>
      page.locator('#zsiq_float, .zsiq-float, #zs_fl_chat, .zsiq-chat-icn'),
    depositButton: (page) => clickable(page, RE.deposit).first(),
    cashierModal: (page) =>
      page.locator('.experience-cashier-modal, .experience-cashier-full').first(),
    ...overrides,
  };
}

function stakes(): BrandConfig {
  const c = getConfig();
  return stakesLike(
    "stakes",
    "Stakes.com",
    c.STAKES_BASE_URL,
    c.STAKES_USERNAME,
    c.STAKES_PASSWORD,
  );
}

function stakes3(): BrandConfig {
  const c = getConfig();
  return stakesLike(
    "stakes3",
    "Stakes3.com",
    c.STAKES3_BASE_URL,
    requireCredential(c.STAKES3_USERNAME, "STAKES3_USERNAME", "stakes3.com"),
    requireCredential(c.STAKES3_PASSWORD, "STAKES3_PASSWORD", "stakes3.com"),
  );
}

function stakescasino(): BrandConfig {
  const c = getConfig();
  return stakesLike(
    "stakescasino",
    "StakesCasino.com",
    c.STAKESCASINO_BASE_URL,
    requireCredential(
      c.STAKESCASINO_USERNAME,
      "STAKESCASINO_USERNAME",
      "stakescasino.com",
    ),
    requireCredential(
      c.STAKESCASINO_PASSWORD,
      "STAKESCASINO_PASSWORD",
      "stakescasino.com",
    ),
    /*
     * This host is served in ENGLISH (the exit node is outside the EU), which
     * breaks two text matchers that are fine in FR/DE/IT/ES. Both are replaced
     * by `.balance-deposit`, measured against the live site:
     *
     *            logged out   bad creds   logged in
     *   matches       0            0           1
     *
     * 1. loggedInMarker — RE.loggedIn is UNANCHORED and contains "account", so
     *    it matches the "Create account" button that is present while logged
     *    OUT. login-rejects-bad-creds then reads a rejected login as a
     *    successful one and fails a working site. The French "Créer un compte"
     *    contains no such word, which is why only English trips it.
     *
     * 2. depositButton — RE.deposit is ANCHORED (^…$) and the element's text
     *    content is "Deposit " WITH A TRAILING SPACE, so it matches nothing
     *    even though the button is right there.
     *
     * `login` itself needs no override: it asserts the login trigger
     * DISAPPEARS, which is language-independent and already passes here.
     */
    {
      loggedInMarker: (page) =>
        page.locator(".balance-deposit").filter({ visible: true }).first(),
      depositButton: (page) =>
        page.locator(".balance-deposit").filter({ visible: true }).first(),
    },
  );
}

/**
 * X7 Casino on x7casino2.com — a different platform from Stakes, so it has its
 * own selector set. Everything below was measured on the live DOM (FR exit).
 *
 * Language comes from the URL, not the IP: /en, /fr, /de and /it all serve
 * from a French exit. Each column therefore pins its own language prefix, so a
 * DE run always gets the German UI regardless of how the root redirects.
 *
 * Traps this config deliberately avoids:
 *  - The home page carries a SIGN-UP form (`.hero-form`) with its own
 *    `input[name="password_input"]` and `form.login-content-form` — the same
 *    name and class the login modal uses. Every login selector is scoped to
 *    `#login-modal`, or the check would type credentials into registration.
 *  - "CREATE ACCOUNT" is visible while logged out and contains "account", so
 *    the shared RE.loggedIn would read a rejected login as a success. The
 *    logged-in marker is the sidebar's `.auth` state instead.
 *  - The submit button is "S'identifier" on /fr — no shared submit word —
 *    and disabled until both fields are filled. Matched by class, not text.
 */
const X7_LOCALES: Record<string, string> = { FR: "fr", DE: "de", IT: "it" };

// Sidebar login control, per locale: LOGIN / CONNEXION / ANMELDUNG / ACCEDI.
const X7_LOGIN = /^(log\s?in|connexion|anmeldung|anmelden|accedi)$/i;

/** Buttons in the sidebar's user box while logged OUT ("CREATE ACCOUNT", "LOGIN"). */
const X7_LOGGED_OUT_BUTTONS = ".sidebar-wrapper:not(.auth) .sidebar-user-section button";

/**
 * Which X7 account this column logs in with — one per country, so no account
 * is seen hopping between FR, DE and IT (see X7_DE_* in config.ts).
 *
 * FR uses X7_USERNAME. DE/IT use their own keys, falling back to X7_USERNAME
 * while those are unset — the same site, so the shared account is valid there;
 * the fallback only costs the isolation, never correctness. Half a pair
 * (username without password) is a configuration mistake and fails loudly.
 */
let warnedX7Fallback = false;
function x7Account(c: RunnerConfig): { username: string; password: string } {
  const own =
    c.CHECK_REGION === "DE"
      ? { prefix: "X7_DE", username: c.X7_DE_USERNAME, password: c.X7_DE_PASSWORD }
      : c.CHECK_REGION === "IT"
        ? { prefix: "X7_IT", username: c.X7_IT_USERNAME, password: c.X7_IT_PASSWORD }
        : null;

  if (own) {
    const hasUser = own.username.trim() !== "";
    const hasPass = own.password.trim() !== "";
    if (hasUser && hasPass) return { username: own.username, password: own.password };
    if (hasUser !== hasPass) {
      throw new Error(
        `${own.prefix}_USERNAME and ${own.prefix}_PASSWORD must be set together — only one is set.`,
      );
    }
    if (!warnedX7Fallback) {
      warnedX7Fallback = true;
      console.warn(`[x7] ${own.prefix}_USERNAME not set — using the shared X7_USERNAME account`);
    }
  }
  return {
    username: requireCredential(c.X7_USERNAME, "X7_USERNAME", "x7casino2.com"),
    password: requireCredential(c.X7_PASSWORD, "X7_PASSWORD", "x7casino2.com"),
  };
}

function x7(): BrandConfig {
  const c = getConfig();
  const account = x7Account(c);
  const origin = c.X7_BASE_URL.replace(/\/+$/, "");
  const baseUrl = `${origin}/${X7_LOCALES[c.CHECK_REGION] ?? "en"}`;
  const loginModal = (page: Page) => page.locator("#login-modal");
  const loginButton = (page: Page) =>
    page.locator(X7_LOGGED_OUT_BUTTONS).filter({ hasText: X7_LOGIN }).filter({ visible: true });

  return {
    id: "x7",
    // A hostname like the other brands' labels: the dashboard and emails strip
    // a leading "<host>.com: " from errors, and show the host elsewhere.
    label: "X7Casino2.com",
    baseUrl,
    username: account.username,
    password: account.password,
    casinoPath: "/casino",
    games: X7_GAMES,
    gameUrl: (game) => `${baseUrl}/casino/${game.path}/real`,
    gameUrlFragment: (game) => `/casino/${game.path}`,

    // Scoped to the logged-OUT sidebar: once authenticated the wrapper gains
    // `.auth` and this matches nothing, which is what loginAndVerify waits for.
    loginTrigger: loginButton,
    /*
     * Click-until-open, not click-once. The sidebar renders before the SPA
     * attaches its handlers, so a click right after domcontentloaded is
     * silently dropped — measured: the modal never opened and every
     * login-dependent check failed while the site was fine.
     */
    openLogin: async (page) => {
      const btn = loginButton(page).first();
      await btn.waitFor({ state: "visible", timeout: 15_000 });
      const modal = loginModal(page);
      // Retry the CLICK only until the modal itself is open. Never re-click an
      // open modal: the button is then behind its backdrop.
      await expect(async () => {
        if (!(await modal.isVisible())) await btn.click({ timeout: 5_000 });
        await modal.waitFor({ state: "visible", timeout: 3_000 });
      }).toPass({ timeout: 30_000 });
      // The modal's form renders separately and is slow over the VPN —
      // measured in production: an open, still-empty modal for several
      // seconds. Waiting on the form inside the click loop re-clicked through
      // the backdrop instead of letting it load.
      await modal
        .locator('input[name="email_username_input"]')
        .waitFor({ state: "visible", timeout: 30_000 });
    },
    usernameField: (page) => loginModal(page).locator('input[name="email_username_input"]'),
    passwordField: (page) => loginModal(page).locator('input[name="password_input"]'),
    submitLogin: (page) => loginModal(page).locator("button.login-button"),
    // Measured: present only after a successful login. A rejected login leaves
    // the modal open and the sidebar unauthenticated.
    loggedInMarker: (page) => page.locator(".sidebar-wrapper.auth").filter({ visible: true }),
    loginErrorMarker: (page) => loginModal(page).locator(".error_label").filter({ hasText: /\S/ }),

    // "Providers" / "Fournisseurs" / ... on /casino; opens a list of provider
    // entries (44 measured), rendered OUTSIDE .game-filter. Same
    // click-until-open as login, for the same hydration reason. Counted, not
    // visibility-checked: the list scrolls, so most entries are off-screen.
    openProviders: async (page) => {
      const btn = page.locator(".providers-menu-btn").filter({ visible: true }).first();
      await btn.waitFor({ state: "visible", timeout: 20_000 });
      const items = page.locator(".providers-menu-list-item");
      await expect(async () => {
        if ((await items.count()) === 0) await btn.click({ timeout: 5_000 });
        await expect(items.first()).toBeAttached({ timeout: 3_000 });
      }).toPass({ timeout: 30_000 });
    },
    providerTiles: (page) => page.locator(".providers-menu-list-item"),
    gameFrame: (page) => page.locator("iframe#gameFrame, iframe.game-iframe").first(),
    // Zoho SalesIQ, same widget ids as Stakes. Measured ~41s to mount while
    // logged out — too close to the 45s Stakes budget.
    chatWidget: (page) => page.locator("#zsiq_float, .zsiq-float, #zs_fl_chat, .zsiq-chat-icn"),
    chatTimeoutMs: 90_000,
    // The only button in the authenticated sidebar's user box ("DÉPOSER",
    // "DEPOSIT", ...). Structural, so it holds in every locale.
    depositButton: (page) =>
      page
        .locator(".sidebar-wrapper.auth .sidebar-user-section .buttons-wrapper button")
        .filter({ visible: true })
        .first(),
    cashierModal: (page) => page.locator(".cashier-modal.show").first(),
    // Payment-method tiles (Mifinity, Pay By Crypto, ...). An open cashier
    // with no methods is a broken cashier.
    cashierContent: (page) => page.locator(".cashier-modal.show .ec-payment-grid-item"),
    /*
     * The sidebar flips to `.auth` before the session is fully written. A
     * navigation in that window keeps the sidebar logged in but launches the
     * game unauthenticated ("Erreur lors du chargement du jeu") — measured 2/2
     * failures navigating immediately, 3/3 passes once the `uesign` cookie
     * (~1-1.5s after login) exists.
     *
     * Soft on purpose: if the cookie is ever renamed, login itself is already
     * proven by the sidebar, so this only falls back to a fixed settle instead
     * of failing the login check. game-load would still fail on a dead session.
     */
    sessionReady: async (page) => {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const cookies = await page.context().cookies();
        if (cookies.some((ck) => ck.name === "uesign")) return;
        await page.waitForTimeout(250);
      }
      console.warn("[x7] session cookie not seen within 10s — continuing after fixed settle");
      await page.waitForTimeout(2_000);
    },
    /*
     * GET …/player/game/<id> is the launch call. Measured: it intermittently
     * answers 403 {"info":{"resultCode":"gameplay_blocked"}} for the test
     * account on every game while the session is valid — the page then shows
     * "Erreur lors du chargement du jeu" and no frame.
     */
    gameLaunchRefusal: async (res) => {
      if (!/\/player\/game\/\d+/.test(res.url()) || res.status() < 400) return null;
      const body = (await res.json().catch(() => null)) as { info?: { resultCode?: unknown } } | null;
      const code = typeof body?.info?.resultCode === "string" ? body.info.resultCode : "no reason given";
      return `HTTP ${res.status()} ${code}`;
    },
  };
}

export function getBrand(id: BrandId): BrandConfig {
  switch (id) {
    case "stakes":
      return stakes();
    case "stakes3":
      return stakes3();
    case "stakescasino":
      return stakescasino();
    case "x7":
      return x7();
  }
}

/**
 * Exactly ONE domain is tested per run, chosen by CHECK_REGION + CHECK_SITE.
 *
 * FR carries two columns (stakes3, x7), but each is its own run: one run
 * driving both would double the traffic from one VPN exit, and a block on one
 * brand would hold back the other's results.
 *
 * Returns an empty array for an unknown pair, which makes every spec skip and
 * the reporter post nothing, rather than guessing a domain.
 */
export function activeBrands(): BrandId[] {
  const site = currentSite();
  return site ? [site] : [];
}

export const BRAND_IDS: BrandId[] = [
  "stakes",
  "stakes3",
  "stakescasino",
  "x7",
];
