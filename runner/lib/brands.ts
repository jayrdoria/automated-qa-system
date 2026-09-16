import type { Page, Locator } from "@playwright/test";
import { getConfig } from "./config";

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
 * Stakes selectors below come from the real login page. X7 selectors are
 * best-effort and flagged; they need one pass with `npm run recon` from a
 * location that can actually reach the site.
 */

export type BrandId = "stakes" | "x7";

export interface BrandConfig {
  id: BrandId;
  label: string;
  baseUrl: string;
  username: string;
  password: string;

  /** Path to the casino/provider listing page. */
  casinoPath: string;
  /** Direct URL to the Wanted Dead or a Wild game in real-play mode. */
  gameUrl: string;

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

function stakes(): BrandConfig {
  const c = getConfig();
  return {
    id: "stakes",
    label: "Stakes.com",
    baseUrl: c.STAKES_BASE_URL,
    username: c.STAKES_USERNAME,
    password: c.STAKES_PASSWORD,
    casinoPath: "/casino",
    gameUrl: `${c.STAKES_BASE_URL}/game/hacksaw/wanted-dead-or-a-wild/real`,

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
  };
}

function x7(): BrandConfig {
  const c = getConfig();
  return {
    id: "x7",
    label: "X7 Casino",
    baseUrl: c.X7_BASE_URL,
    username: c.X7_USERNAME,
    password: c.X7_PASSWORD,
    casinoPath: "/en/casino",
    gameUrl: `${c.X7_BASE_URL}/en/casino/hacksaw/0z-wanted-dead-or-a-wild/real`,

    loginTrigger: (page) => clickable(page, RE.login),
    // ⚠ UNVERIFIED — X7 opens a login MODAL and is still Cloudflare-challenged.
    openLogin: async (page) => {
      await clickable(page, RE.login).first().click();
      await page.locator('[role="dialog"], [class*="modal" i]').first().waitFor({
        state: "visible",
        timeout: 15000,
      });
    },
    usernameField: (page) => page.getByPlaceholder(RE.username).first(),
    passwordField: (page) => page.getByPlaceholder(RE.password).first(),
    submitLogin: (page) => clickable(page, RE.submit).last(),
    loggedInMarker: (page) =>
      clickable(page, RE.loggedIn).first(),
    loginErrorMarker: (page) => page.getByText(RE.error).first(),

    // ⚠ All X7 selectors below are UNVERIFIED — the site is still behind a
    // Cloudflare challenge, so its DOM has never been observed. Structure
    // mirrors Stakes as a starting point; expect to correct these once the
    // whitelist lands.
    openProviders: async (page) => {
      const toggle = clickable(page, RE.providers).first();
      await toggle.waitFor({ state: "visible", timeout: 20_000 });
      await toggle.click();
    },
    providerTiles: (page) => page.locator('input[type="checkbox"]'),
    gameFrame: (page) =>
      page.locator('iframe[src*="game" i], iframe[allow*="fullscreen" i], main iframe').first(),
    chatWidget: (page) =>
      page.locator('#zsiq_float, .zsiq-float, #zs_fl_chat, .zsiq-chat-icn, #launcher'),
    depositButton: (page) => clickable(page, RE.deposit).first(),
    cashierModal: (page) =>
      page.locator('.experience-cashier-modal, .experience-cashier-full, [role="dialog"]').first(),
  };
}

export function getBrand(id: BrandId): BrandConfig {
  return id === "stakes" ? stakes() : x7();
}

/**
 * X7 is excluded unless X7_ENABLED=true. It is blocked by a Cloudflare
 * interactive challenge that a VPN cannot clear, so running its checks would
 * post 7 permanent failures and bury the Stakes signal under red.
 */
export function activeBrands(): BrandId[] {
  return getConfig().X7_ENABLED ? ["stakes", "x7"] : ["stakes"];
}

export const BRAND_IDS: BrandId[] = ["stakes", "x7"];
