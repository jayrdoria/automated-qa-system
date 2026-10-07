import { explainFailure, VERDICT_LABELS } from "./failures";
import { CANARY_CHECK, CHECKS, CHECK_LABELS, COLUMNS, SITE_DOMAINS, gameName, type Brand } from "./checks";

/**
 * Builds alert emails: a subject, a plain-text body and an HTML body.
 *
 * The plain-text part is not a fallback — it is the primary format. Alerts go
 * to a Slack channel's email address, and Slack previews the text part; many
 * people will never open the HTML. So the text has to read well on its own,
 * top to bottom: what broke, where, is it real, since when, then the raw log.
 *
 * One email describes one RUN (one domain in one market), never one check: a
 * run with three failures is one message listing three checks, so the channel
 * shows exactly one entry per red run on the dashboard.
 *
 * Pure (no I/O) so it can be rendered to local previews and unit-checked.
 */

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

function place(brand: string, region: string) {
  const domain = SITE_DOMAINS[brand as Brand] ?? brand;
  const market = COLUMNS.find((c) => c.region === region)?.label ?? region;
  return { domain, market };
}

/** "Game load (Ze Zeus)" — the check, plus the game when there is one. */
export function checkLabel(checkName: string, target?: string | null): string {
  const label = CHECK_LABELS[checkName] ?? checkName;
  const game = gameName(target);
  return game ? `${label} (${game})` : label;
}

function historyLine(recent: { status: string }[] | undefined): string | null {
  if (!recent || recent.length === 0) return null;
  const failed = recent.filter((r) => r.status === "fail").length;
  const marks = recent
    .slice()
    .reverse()
    .map((r) => (r.status === "fail" ? "✗" : "✓"))
    .join(" ");
  return `Failed ${failed} of the last ${plural(recent.length, "run")}  (oldest → newest: ${marks})`;
}

function ordinal(n: number): string {
  const suffix = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (suffix[(v - 20) % 10] ?? suffix[v] ?? suffix[0]!);
}

/** Dashboard order (site-up first), so the same run always lists the same way. */
export function byCheckOrder<T extends { checkName: string }>(items: T[]): T[] {
  const rank = (name: string) => {
    const i = CHECKS.findIndex((c) => c.id === name);
    return i === -1 ? CHECKS.length : i;
  };
  return items.slice().sort((a, b) => rank(a.checkName) - rank(b.checkName));
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

// ── Shared layout ──────────────────────────────────────────────────────────

const RED = "#dc2626";
const ORANGE = "#d97706";
const GREEN = "#059669";
const GREY = "#6b7280";

type Facts = [string, string][];

function textFacts(facts: Facts, indent = ""): string[] {
  if (facts.length === 0) return [];
  const pad = Math.max(...facts.map(([k]) => k.length));
  return facts.map(([k, v]) => `${indent}${(k + ":").padEnd(pad + 2)}${v}`);
}

function htmlFacts(facts: Facts, margin = "0 0 16px"): string {
  if (facts.length === 0) return "";
  const rows = facts
    .map(
      ([k, v]) =>
        `<tr><td style="padding:4px 12px 4px 0;color:#6b7280;white-space:nowrap;vertical-align:top">${escapeHtml(k)}</td>` +
        `<td style="padding:4px 0;color:#111827">${escapeHtml(v)}</td></tr>`,
    )
    .join("");
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:${margin}">${rows}</table>`;
}

interface Frame {
  tag: string;
  accent: string;
  title: string;
  lead: string;
  facts: Facts;
  dashboardUrl: string;
  test?: boolean;
  /** Between the facts and the dashboard button. */
  textBody?: string[];
  htmlBody?: string;
  /** Raw logs, after everything a non-developer needs. */
  textTechnical?: string[];
  htmlTechnical?: string;
}

function frame(f: Frame): { text: string; html: string } {
  const text: string[] = [];
  if (f.test) {
    text.push("============================================================");
    text.push(" TEST MESSAGE — not a real alert. No action needed.");
    text.push("============================================================", "");
  }
  text.push(f.title, "", f.lead, "", ...textFacts(f.facts));
  if (f.textBody?.length) text.push("", ...f.textBody);
  text.push("", `Dashboard: ${f.dashboardUrl}`);
  if (f.textTechnical?.length) text.push("", "── Technical details ──", ...f.textTechnical);

  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#f3f4f6;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.5">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:640px;margin:0 auto;background:#ffffff;border-radius:8px;border-top:4px solid ${f.accent}">
<tr><td style="padding:24px">
${f.test ? `<div style="margin:0 0 16px;padding:10px 12px;background:#fef3c7;border:1px solid #f59e0b;border-radius:6px;color:#92400e;font-weight:600">TEST MESSAGE — not a real alert. No action needed.</div>` : ""}
<div style="font-size:12px;font-weight:600;letter-spacing:.04em;color:${f.accent}">${escapeHtml(f.tag)}</div>
<h1 style="margin:4px 0 8px;font-size:20px;color:#111827">${escapeHtml(f.title)}</h1>
<p style="margin:0 0 16px;color:#374151">${escapeHtml(f.lead)}</p>
${htmlFacts(f.facts)}
${f.htmlBody ?? ""}
<p style="margin:0 0 16px"><a href="${escapeHtml(f.dashboardUrl)}" style="display:inline-block;padding:8px 14px;background:#111827;color:#ffffff;text-decoration:none;border-radius:6px">Open dashboard</a></p>
${f.htmlTechnical ?? ""}
</td></tr></table></body></html>`;

  return { text: text.join("\n"), html };
}

// ── Failures ───────────────────────────────────────────────────────────────

export interface FailedCheck {
  checkName: string;
  /** The game, for game-load. */
  target?: string | null;
  error?: string | null;
  /** True when this run is the first to fail; false when earlier runs failed too. */
  isNew: boolean;
  /** When the current failure began. */
  since: Date;
  /** Consecutive failed runs, including this one. */
  streak: number;
  /** Recent run history for this exact check (and game), newest first. */
  recent?: { status: string }[];
  /** Label of a check that also failed and that this one cannot pass without. */
  causedBy?: string | null;
  /** Content-ID of this check's inline screenshot, when one is attached. */
  screenshotCid?: string | null;
}

export interface RunAlertInput {
  brand: string;
  region: string;
  startedAt: Date;
  /** Every check that failed in this run. Must not be empty. */
  failures: FailedCheck[];
  /** How many checks reported in this run, failed or not. */
  total: number;
  /** Labels of checks Cloudflare refused in this run — never tested. */
  blocked?: string[];
  /** Every check past the homepage failed: down or in maintenance. */
  allFailed?: boolean;
  dashboardUrl: string;
  /** Marks the email unmistakably as a test. */
  test?: boolean;
}

/** Per-check log length. One failure gets more room than seven sharing an email. */
const TECHNICAL_SINGLE = 1500;
const TECHNICAL_EACH = 600;

export function renderRunAlert(input: RunAlertInput): RenderedEmail {
  const { domain, market } = place(input.brand, input.region);
  const items = byCheckOrder(input.failures).map((f) => ({
    f,
    x: explainFailure(f.error),
    label: checkLabel(f.checkName, f.target),
  }));
  const primary = items.find((i) => i.f.checkName === CANARY_CHECK) ?? items[0];
  if (!primary) throw new Error("renderRunAlert called without failures");

  const n = items.length;
  const allFailed = !!input.allFailed;
  const siteDown = allFailed || primary.f.checkName === CANARY_CHECK;
  const anyNew = items.some((i) => i.f.isNew);
  const tag = siteDown ? "🔴 SITE DOWN" : anyNew ? "🔴 FAILING" : "🟠 STILL FAILING";
  const accent = siteDown || anyNew ? RED : ORANGE;
  const head = `${input.test ? "[TEST] " : ""}${tag} · ${domain} · ${market}`;

  // ── Subject: what Slack shows in the channel ──────────────────────────────
  let subject: string;
  if (allFailed) subject = `${head} — every check failed (down or in maintenance)`;
  else if (n === 1 && siteDown) subject = `${head} — ${primary.x.headline}`;
  else if (n === 1) subject = `${head} · ${primary.label} — ${primary.x.headline}`;
  else if (siteDown) subject = `${head} — ${primary.x.headline} (+${n - 1} more failed)`;
  else subject = `${head} — ${n} checks failed: ${items.map((i) => i.label).join(", ")}`;

  const title = allFailed
    ? `${domain} looks down or in maintenance in ${market}`
    : siteDown
      ? `${domain} looks down in ${market}`
      : n === 1
        ? primary.x.headline
        : `${n} checks failed on ${domain} in ${market}`;

  const lead = allFailed
    ? `Every check in this run failed, so the site is most likely down or in maintenance. ` +
      `The first failure was: ${primary.x.headline.charAt(0).toLowerCase()}${primary.x.headline.slice(1)}.`
    : siteDown
      ? `The homepage check failed on ${domain} (${market}), so the site is most likely down.` +
        (n > 1 ? ` ${plural(n - 1, "other check")} failed in the same run.` : "")
      : n === 1
        ? `${primary.label} failed on ${domain} (${market}) in the latest run.`
        : `${n} of ${input.total} checks failed on ${domain} (${market}) in the latest run.`;

  const blocked = input.blocked ?? [];
  const facts: Facts = [
    ["Where", `${domain} · ${market} (${input.region})`],
    ["Checked at", formatLocal(input.startedAt)],
    [
      "Result",
      `${n} of ${input.total} checks failed` + (blocked.length ? `, ${blocked.length} not tested` : ""),
    ],
  ];

  // ── One block per failed check ────────────────────────────────────────────
  const textBody: string[] = [];
  const htmlItems: string[] = [];
  const techMax = n === 1 ? TECHNICAL_SINGLE : TECHNICAL_EACH;
  const textTechnical: string[] = [];
  const htmlTechnical: string[] = [];

  items.forEach(({ f, x, label }, idx) => {
    const num = `${idx + 1}.`;
    const status = f.isNew
      ? "NEW — failed for the first time"
      : `STILL FAILING — ${ordinal(f.streak)} run in a row, since ${formatLocal(f.since)} ` +
        `(${formatDuration(input.startedAt.getTime() - f.since.getTime())})`;
    const itemFacts: Facts = [
      ["Status", status],
      ["Verdict", VERDICT_LABELS[x.verdict]],
    ];
    const hist = historyLine(f.recent);
    if (hist) itemFacts.push(["History", hist]);
    if (f.causedBy) {
      itemFacts.push(["Likely cause", `${f.causedBy} also failed, and this check cannot pass without it`]);
    }
    if (f.screenshotCid) itemFacts.push(["Screenshot", "attached"]);

    if (idx > 0) textBody.push("");
    textBody.push(`${num} ${label} — ${x.headline}`, ...textFacts(itemFacts, "   "), `   ${x.detail}`);

    const badgeBg = f.isNew ? "#fee2e2" : "#ffedd5";
    const badgeFg = f.isNew ? "#991b1b" : "#9a3412";
    htmlItems.push(
      `<div style="margin:0 0 16px;padding:12px 14px;border:1px solid #e5e7eb;border-left:4px solid ${f.isNew ? RED : ORANGE};border-radius:6px">` +
        `<div style="margin:0 0 4px;font-weight:600;color:#111827">${escapeHtml(`${num} ${label} — ${x.headline}`)} ` +
        `<span style="display:inline-block;margin-left:4px;padding:1px 6px;border-radius:4px;background:${badgeBg};color:${badgeFg};font-size:11px;font-weight:600">${f.isNew ? "NEW" : "STILL FAILING"}</span></div>` +
        `<p style="margin:0 0 8px;color:#374151">${escapeHtml(x.detail)}</p>` +
        htmlFacts(itemFacts.filter(([k]) => k !== "Screenshot"), "0 0 8px") +
        (f.screenshotCid
          ? `<p style="margin:0 0 4px;color:#6b7280;font-size:12px">What the check saw:</p>` +
            `<img src="cid:${escapeHtml(f.screenshotCid)}" alt="Screenshot of ${escapeHtml(label)} at the moment of failure" style="max-width:100%;border:1px solid #e5e7eb;border-radius:6px">`
          : "") +
        `</div>`,
    );

    if (x.technical) {
      const tech = x.technical.slice(0, techMax) + (x.technical.length > techMax ? " …(truncated)" : "");
      if (textTechnical.length) textTechnical.push("");
      textTechnical.push(`[${num} ${label}]`, tech);
      htmlTechnical.push(
        `<details style="margin:0 0 8px"><summary style="cursor:pointer;color:#6b7280;font-size:12px">Technical details — ${escapeHtml(`${num} ${label}`)}</summary>` +
          `<pre style="white-space:pre-wrap;word-break:break-word;font-size:11px;color:#4b5563;background:#f9fafb;padding:10px;border-radius:6px">${escapeHtml(tech)}</pre></details>`,
      );
    }
  });

  if (blocked.length) {
    const line =
      `Not tested — Cloudflare refused ${blocked.join(", ")} before reaching the site, ` +
      `so this run says nothing about ${blocked.length === 1 ? "it" : "them"}.`;
    textBody.push("", line);
    htmlItems.push(
      `<p style="margin:0 0 16px;padding:10px 12px;background:#f9fafb;border-radius:6px;color:#374151">${escapeHtml(line)}</p>`,
    );
  }

  const { text, html } = frame({
    tag,
    accent,
    title,
    lead,
    facts,
    dashboardUrl: input.dashboardUrl,
    test: input.test,
    textBody,
    htmlBody: htmlItems.join("\n"),
    textTechnical,
    htmlTechnical: htmlTechnical.join("\n"),
  });
  return { subject, text, html };
}

// ── Recoveries ─────────────────────────────────────────────────────────────

export interface RecoveredCheck {
  checkName: string;
  target?: string | null;
  /** When the failure that just ended began. */
  since: Date;
  recent?: { status: string }[];
}

export interface RecoveryAlertInput {
  brand: string;
  region: string;
  startedAt: Date;
  /** Every check that passed again in this run. Must not be empty. */
  recovered: RecoveredCheck[];
  dashboardUrl: string;
  test?: boolean;
}

export function renderRecoveryAlert(input: RecoveryAlertInput): RenderedEmail {
  const { domain, market } = place(input.brand, input.region);
  const items = byCheckOrder(input.recovered).map((r) => ({ r, label: checkLabel(r.checkName, r.target) }));
  const first = items[0];
  if (!first) throw new Error("renderRecoveryAlert called without recoveries");

  const n = items.length;
  const tag = "✅ RECOVERED";
  const head = `${input.test ? "[TEST] " : ""}${tag} · ${domain} · ${market}`;
  const failedFor = (since: Date) => formatDuration(input.startedAt.getTime() - since.getTime());

  const subject =
    n === 1
      ? `${head} · ${first.label}`
      : `${head} — ${n} checks working again: ${items.map((i) => i.label).join(", ")}`;
  const title = n === 1 ? `${first.label} is working again` : `${n} checks are working again`;
  const lead =
    n === 1
      ? `${first.label} on ${domain} (${market}) passed again after failing for ${failedFor(first.r.since)}.`
      : `These checks on ${domain} (${market}) passed again in the latest run.`;

  const facts: Facts = [
    ["Where", `${domain} · ${market} (${input.region})`],
    ["Checked at", formatLocal(input.startedAt)],
  ];

  const textBody: string[] = [];
  const htmlItems: string[] = [];
  items.forEach(({ r, label }, idx) => {
    const itemFacts: Facts = [["Was failing", `for ${failedFor(r.since)}, since ${formatLocal(r.since)}`]];
    const hist = historyLine(r.recent);
    if (hist) itemFacts.push(["History", hist]);

    if (idx > 0) textBody.push("");
    textBody.push(`${idx + 1}. ${label}`, ...textFacts(itemFacts, "   "));
    htmlItems.push(
      `<div style="margin:0 0 12px;padding:10px 14px;border:1px solid #e5e7eb;border-left:4px solid ${GREEN};border-radius:6px">` +
        `<div style="margin:0 0 4px;font-weight:600;color:#111827">${escapeHtml(`${idx + 1}. ${label}`)}</div>` +
        htmlFacts(itemFacts, "0") +
        `</div>`,
    );
  });

  const { text, html } = frame({
    tag,
    accent: GREEN,
    title,
    lead,
    facts,
    dashboardUrl: input.dashboardUrl,
    test: input.test,
    textBody,
    htmlBody: htmlItems.join("\n"),
  });
  return { subject, text, html };
}

// ── Whole run blocked at the edge ──────────────────────────────────────────

export interface BlockedAlertInput {
  brand: string;
  region: string;
  startedAt: Date;
  blockedCount: number;
  dashboardUrl: string;
  test?: boolean;
}

export function renderBlockedAlert(input: BlockedAlertInput): RenderedEmail {
  const { domain, market } = place(input.brand, input.region);
  const tag = "⛔ BLOCKED";
  const subject = `${input.test ? "[TEST] " : ""}${tag} · ${domain} · ${market} — the checks could not reach the site`;
  const { text, html } = frame({
    tag,
    accent: GREY,
    title: "The checks could not reach the site",
    lead:
      `All ${input.blockedCount} checks in the ${domain} · ${market} run were refused by Cloudflare ` +
      "before reaching the site. This says nothing about whether the site works — the VPN exit's " +
      "IP address was blocked. Runs normally recover on their own.",
    facts: [
      ["Where", `${domain} · ${market} (${input.region})`],
      ["Checked at", formatLocal(input.startedAt)],
    ],
    dashboardUrl: input.dashboardUrl,
    test: input.test,
  });
  return { subject, text, html };
}
