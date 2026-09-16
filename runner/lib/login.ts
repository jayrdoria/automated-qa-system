import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";
import type { BrandConfig } from "./brands";
import { gotoChecked } from "./preflight";

/**
 * Stakes reveals an inline form under the header; X7 opens a modal. The
 * difference is encapsulated in each brand's `openLogin`, so this stays shared.
 */
export async function login(
  page: Page,
  brand: BrandConfig,
  credentials?: { username: string; password: string },
): Promise<void> {
  const { username, password } = credentials ?? {
    username: brand.username,
    password: brand.password,
  };

  await gotoChecked(page, brand.baseUrl);
  await brand.openLogin(page);

  const user = brand.usernameField(page);
  await user.waitFor({ state: "visible", timeout: 15_000 });
  await user.fill(username);
  await brand.passwordField(page).fill(password);
  await brand.submitLogin(page).click();
}

/**
 * Full login + assertion that a session actually exists.
 *
 * Verified by the login trigger disappearing rather than an account control
 * appearing: post-login Stakes shows icon-only controls with no text, so any
 * positive text matcher is brittle. The trigger vanishing is unambiguous and
 * survives both languages.
 */
export async function loginAndVerify(page: Page, brand: BrandConfig): Promise<void> {
  await login(page, brand);
  await expect(
    brand.loginTrigger(page),
    `${brand.label}: still showing the login control after sign-in — session not established`,
  ).toHaveCount(0, { timeout: 30_000 });
}
