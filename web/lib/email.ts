import { explainFailure, VERDICT_LABELS, type Explanation } from "./failures";
import { CHECK_LABELS, COLUMNS, SITE_DOMAINS, gameName, type Brand } from "./checks";

/**
 * Builds alert emails: a subject, a plain-text body and an HTML body.
 *
 * The plain-text part is not a fallback — it is the primary format. Alerts go
 * to a Slack channel's email address, and Slack previews the text part; many
 * people will never open the HTML. So the text has to read well on its own,
 * top to bottom: what broke, where, is it real, since when, then the raw log.
 *
 * Pure (no I/O) so it can be rendered to local previews and unit-checked.
 */

export type AlertKind = "failing" | "still-failing" | "recovered" | "site-down" | "blocked";

export interface AlertInput {
  kind: AlertKind;
  brand: string;
  region: string;
  checkName: string;
  /** The game, for game-load. */
  target?: string | null;
  error?: string | null;
  startedAt: Date;
  /** When the current failure (or, for recovery, the outage) began. */
  since?: Date;
  /** Recent run history for this exact check, newest first. */
  recent?: { status: string }[];
  /** Checks that failed in the same run as a consequence of this one. */
  consequences?: string[];
  /** Why they failed — see consequenceReason() in incidents.ts. */
  consequenceReason?: string;
  /** Every check in the run failed: down or in maintenance. */
  allFailed?: boolean;
  /** For blocked: how many checks were blocked. */
  blockedCount?: number;
  dashboardUrl: string;
  /** Marks the email unmistakably as a test. */
  test?: boolean;
  /** Content-ID of an inline screenshot, when one is attached. */
  screenshotCid?: string | null;
}

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

const TZ = "Asia/Manila"; // +08:00 — the team's timezone, and the server's.

export function formatLocal(d: Date): string {
  return (
    new Intl.DateTimeFormat("en-GB", {
      timeZone: TZ,
      day: "numeric",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(d) + " (+08)"
  );
}

export function formatDuration(ms: number): string {
  const mins = Math.max(0, Math.round(ms / 60_000));
  if (mins < 1) return "under a minute";
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  if (h < 48) return `${h}h ${mins % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function where(input: AlertInput) {
  const domain = SITE_DOMAINS[input.brand as Brand] ?? input.brand;
  const market = COLUMNS.find((c) => c.region === input.region)?.label ?? input.region;
  const check = CHECK_LABELS[input.checkName] ?? input.checkName;
  const game = gameName(input.target);
  return { domain, market, check, game };
}

function historyLine(recent: { status: string }[] | undefined): string | null {
  if (!recent || recent.length === 0) return null;
  const failed = recent.filter((r) => r.status === "fail").length;
  const marks = recent
    .slice()
    .reverse()
    .map((r) => (r.status === "fail" ? "✗" : "✓"))
    .join(" ");
  return `Failed ${failed} of the last ${recent.length} runs  (oldest → newest: ${marks})`;
}

const HEADLINE_BY_KIND: Record<AlertKind, string> = {
  failing: "🔴 FAILING",
  "still-failing": "🟠 STILL FAILING",
  recovered: "✅ RECOVERED",
  "site-down": "🔴 SITE DOWN",
  blocked: "⛔ BLOCKED",
};

const TECHNICAL_IN_EMAIL = 1500;

export function renderAlert(input: AlertInput): RenderedEmail {
  const { domain, market, check, game } = where(input);
  const x: Explanation = explainFailure(input.error);
  const testTag = input.test ? "[TEST] " : "";
  const tag = HEADLINE_BY_KIND[input.kind];

  // ── Subject ──────────────────────────────────────────────────────────────
  let subject: string;
  let title: string;
  let lead: string;
  switch (input.kind) {
    case "blocked":
      subject = `${testTag}${tag} · QA checks could not reach the sites`;
      title = "The checks could not reach the sites";
      lead =
        `All ${input.blockedCount ?? "the"} checks in the ${domain} · ${market} run were refused ` +
        "by Cloudflare before reaching the site. This says nothing about whether the site " +
        "works — the VPN exit's IP address was blocked. Runs normally recover on their own.";
      break;
    case "recovered":
      subject = `${testTag}${tag} · ${domain} · ${market} · ${check}${game ? ` (${game})` : ""}`;
      title = `${check}${game ? ` — ${game}` : ""} is working again`;
      lead =
        `${check}${game ? ` for ${game}` : ""} on ${domain} (${market}) passed again` +
        (input.since ? ` after failing for ${formatDuration(input.startedAt.getTime() - input.since.getTime())}.` : ".");
      break;
    case "site-down":
      subject = input.allFailed
        ? `${testTag}${tag} · ${domain} · ${market} — every check failed (down or in maintenance)`
        : `${testTag}${tag} · ${domain} · ${market} — ${x.headline}`;
      title = input.allFailed
        ? `${domain} looks down or in maintenance in ${market}`
        : `${domain} looks down in ${market}`;
      lead = input.allFailed
        ? `Every check in this run failed. The first failure was: ${x.headline.toLowerCase()}. ${x.detail}`
        : x.detail;
      break;
    default:
      subject = `${testTag}${tag} · ${domain} · ${market} · ${check}${game ? ` (${game})` : ""} — ${x.headline}`;
      title = x.headline;
      lead = x.detail;
  }

  // ── Facts, shared by both bodies ─────────────────────────────────────────
  const facts: [string, string][] = [];
  facts.push(["Where", `${domain} · ${market} (${input.region})`]);
  if (input.kind !== "blocked") facts.push(["Check", check + (game ? ` — ${game}` : "")]);
  if (input.kind !== "recovered" && input.kind !== "blocked") {
    facts.push(["Verdict", VERDICT_LABELS[x.verdict]]);
  }
  if (input.since && input.kind !== "recovered") {
    facts.push([
      "Failing since",
      `${formatLocal(input.since)} — ${formatDuration(input.startedAt.getTime() - input.since.getTime())}`,
    ]);
  }
  facts.push(["Checked at", formatLocal(input.startedAt)]);
  const hist = historyLine(input.recent);
  if (hist && input.kind !== "blocked") facts.push(["History", hist]);

  const consequences =
    input.consequences && input.consequences.length > 0
      ? `${input.consequenceReason ?? "Because of this failure"}: ${input.consequences.length} other ` +
        `check${input.consequences.length === 1 ? "" : "s"} also failed and ${input.consequences.length === 1 ? "is" : "are"} ` +
        `NOT reported separately — ${input.consequences.join(", ")}.`
      : null;

  const technical =
    input.kind === "failing" || input.kind === "still-failing" || input.kind === "site-down"
      ? x.technical.slice(0, TECHNICAL_IN_EMAIL) +
        (x.technical.length > TECHNICAL_IN_EMAIL ? " …(truncated)" : "")
      : "";

  // ── Plain text — the format Slack actually shows ─────────────────────────
  const text: string[] = [];
  if (input.test) {
    text.push("============================================================");
    text.push(" TEST MESSAGE — not a real alert. No action needed.");
    text.push("============================================================", "");
  }
  text.push(title, "", lead, "");
  const pad = Math.max(...facts.map(([k]) => k.length));
  for (const [k, v] of facts) text.push(`${(k + ":").padEnd(pad + 2)}${v}`);
  if (consequences) text.push("", consequences);
  if (input.screenshotCid) text.push("", "Screenshot attached.");
  text.push("", `Dashboard: ${input.dashboardUrl}`);
  if (technical) text.push("", "── Technical details ──", technical);

  // ── HTML ─────────────────────────────────────────────────────────────────
  const accent =
    input.kind === "recovered" ? "#059669" : input.kind === "still-failing" ? "#d97706" : input.kind === "blocked" ? "#6b7280" : "#dc2626";
  const rows = facts
    .map(
      ([k, v]) =>
        `<tr><td style="padding:4px 12px 4px 0;color:#6b7280;white-space:nowrap;vertical-align:top">${escapeHtml(k)}</td>` +
        `<td style="padding:4px 0;color:#111827">${escapeHtml(v)}</td></tr>`,
    )
    .join("");
  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#f3f4f6;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.5">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:640px;margin:0 auto;background:#ffffff;border-radius:8px;border-top:4px solid ${accent}">
<tr><td style="padding:24px">
${input.test ? `<div style="margin:0 0 16px;padding:10px 12px;background:#fef3c7;border:1px solid #f59e0b;border-radius:6px;color:#92400e;font-weight:600">TEST MESSAGE — not a real alert. No action needed.</div>` : ""}
<div style="font-size:12px;font-weight:600;letter-spacing:.04em;color:${accent}">${escapeHtml(tag)}</div>
<h1 style="margin:4px 0 8px;font-size:20px;color:#111827">${escapeHtml(title)}</h1>
<p style="margin:0 0 16px;color:#374151">${escapeHtml(lead)}</p>
<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 16px">${rows}</table>
${consequences ? `<p style="margin:0 0 16px;padding:10px 12px;background:#f9fafb;border-radius:6px;color:#374151">${escapeHtml(consequences)}</p>` : ""}
${input.screenshotCid ? `<p style="margin:0 0 8px;color:#6b7280;font-size:12px">What the check saw:</p><img src="cid:${escapeHtml(input.screenshotCid)}" alt="Screenshot at the moment of failure" style="max-width:100%;border:1px solid #e5e7eb;border-radius:6px;margin:0 0 16px">` : ""}
<p style="margin:0 0 16px"><a href="${escapeHtml(input.dashboardUrl)}" style="display:inline-block;padding:8px 14px;background:#111827;color:#ffffff;text-decoration:none;border-radius:6px">Open dashboard</a></p>
${technical ? `<details><summary style="cursor:pointer;color:#6b7280;font-size:12px">Technical details</summary><pre style="white-space:pre-wrap;word-break:break-word;font-size:11px;color:#4b5563;background:#f9fafb;padding:10px;border-radius:6px">${escapeHtml(technical)}</pre></details>` : ""}
</td></tr></table></body></html>`;

  return { subject, text: text.join("\n"), html };
}
