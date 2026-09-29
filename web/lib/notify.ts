import nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";
import path from "node:path";
import fs from "node:fs";
import { getEnv } from "./env";
import type { RenderedEmail } from "./email";

/**
 * Gmail SMTP → the Slack channel's email-to-channel address.
 * Same shape as leave-management-system/utils/mailer.js: port 587, STARTTLS.
 */

let transporter: Transporter | null = null;

function getTransporter(): Transporter | null {
  const env = getEnv();
  if (!env.SMTP_HOST || !env.SMTP_USER || !env.SMTP_PASS || !env.ALERT_TO) {
    return null; // alerting not configured yet — checks still record fine
  }
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: 587,
      secure: false,
      auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
    });
  }
  return transporter;
}

const ARTIFACTS_ROOT = process.env.ARTIFACTS_DIR ?? "/app/artifacts/test-results";

/** Content-ID the HTML body references to show the screenshot inline. */
export const SCREENSHOT_CID = "failure-screenshot@qa-monitor";

/**
 * Resolves a runner-reported screenshot path to a file that exists, or null.
 *
 * Contains the path: the runner is trusted, but a traversal here would let a
 * malformed report attach arbitrary files from the container. Resolved BEFORE
 * rendering, so the email only references an inline image that will really be
 * attached — a dangling cid shows as a broken image.
 */
export function resolveScreenshot(relative: string | null | undefined): string | null {
  if (!relative) return null;
  const root = path.resolve(ARTIFACTS_ROOT);
  const resolved = path.resolve(root, relative);
  if (!resolved.startsWith(root + path.sep)) return null;
  return fs.existsSync(resolved) ? resolved : null;
}

/**
 * Real alerts go out ONLY from the production build.
 *
 * Checking for SMTP credentials is not enough to keep a dev server quiet: the
 * generated Prisma client auto-loads the repo-root .env (its schemaEnvPath),
 * which carries the real SMTP_* and ALERT_TO. So a local `next dev` has live
 * mail credentials even though web/.env.local contains none — and local testing
 * once posted a batch of unmarked alerts into the real Slack channel that way.
 *
 * The production image sets NODE_ENV=production (web/Dockerfile). Anything else
 * logs what it WOULD have sent. ALERT_SEND_IN_DEV=1 overrides this for a
 * deliberate test send.
 */
function sendingAllowed(): boolean {
  return process.env.NODE_ENV === "production" || process.env.ALERT_SEND_IN_DEV === "1";
}

export async function sendAlert(
  email: RenderedEmail,
  screenshotPath?: string | null,
): Promise<boolean> {
  if (!sendingAllowed()) {
    console.warn(`[notify] not production — suppressed alert: ${email.subject}`);
    return false;
  }
  const tx = getTransporter();
  if (!tx) {
    console.warn(`[notify] SMTP not configured — dropping alert: ${email.subject}`);
    return false;
  }
  const env = getEnv();

  try {
    await tx.sendMail({
      from: `"QA Monitor" <${env.SMTP_USER}>`,
      to: env.ALERT_TO,
      subject: email.subject,
      text: email.text,
      html: email.html,
      attachments: screenshotPath
        ? [{ filename: path.basename(screenshotPath), path: screenshotPath, cid: SCREENSHOT_CID }]
        : [],
    });
    return true;
  } catch (e) {
    console.error(`[notify] send failed: ${(e as Error).message}`);
    return false;
  }
}
