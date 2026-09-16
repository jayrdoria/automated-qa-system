import nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";
import path from "node:path";
import fs from "node:fs";
import { getEnv } from "./env";

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

export interface Alert {
  subject: string;
  lines: string[];
  /** Path relative to the artifacts root, as reported by the runner. */
  screenshot?: string | null;
}

const ARTIFACTS_ROOT = process.env.ARTIFACTS_DIR ?? "/app/artifacts/test-results";

export async function sendAlert(alert: Alert): Promise<boolean> {
  const tx = getTransporter();
  if (!tx) {
    console.warn(`[notify] SMTP not configured — dropping alert: ${alert.subject}`);
    return false;
  }
  const env = getEnv();

  const attachments: { filename: string; path: string }[] = [];
  if (alert.screenshot) {
    // Contain the path: the runner is trusted, but a traversal here would let
    // a malformed report attach arbitrary files from the container.
    const resolved = path.resolve(ARTIFACTS_ROOT, alert.screenshot);
    if (resolved.startsWith(path.resolve(ARTIFACTS_ROOT)) && fs.existsSync(resolved)) {
      attachments.push({ filename: path.basename(resolved), path: resolved });
    }
  }

  try {
    await tx.sendMail({
      from: `"QA Monitor" <${env.SMTP_USER}>`,
      to: env.ALERT_TO,
      subject: alert.subject,
      text: alert.lines.join("\n"),
      attachments,
    });
    return true;
  } catch (e) {
    console.error(`[notify] send failed: ${(e as Error).message}`);
    return false;
  }
}
