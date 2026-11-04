/**
 * The credentials register, pure part (no node imports).
 *
 * Nothing recorded when a credential expires or checked that it still works:
 * the day the GitHub token lapses every agent's push fails at once and nobody
 * is told. The register holds names and places only (never a value), the
 * expiry where one is known, how to rotate, and when it was last checked. The
 * Cockpit warns 30 days before an expiry and goes red at 7 days, when it has
 * passed, or when the provider refuses the credential.
 */
import type { HealthCheck } from "@partnersinbiz/pib-plugin-kit/cockpit";
import { redactSecrets } from "./watch-model.js";

export type CredentialStatus = "active" | "retired" | "burned";
export type VerifyStatus = "ok" | "invalid" | "expired" | "unreachable" | "unsupported" | "not_configured";

export class CredentialError extends Error {}

/** Which provider checks exist (`verifiers` in credentials.ts); a row names one in `verifyWith`. */
export const VERIFY_PROVIDERS = ["github", "cloudflare", "resend", "browser"] as const;
export type VerifyProvider = (typeof VERIFY_PROVIDERS)[number];
/** The providers checked with a token and one GET. `browser` is read from the pib-browser status file instead (no secret). */
export type TokenProvider = Exclude<VerifyProvider, "browser">;

export const EXPIRY_WARN_DAYS = 30;
export const EXPIRY_BAD_DAYS = 7;

export interface CredentialRow {
  id: string;
  companyId: string;
  seedKey: string | null;
  name: string;
  system: string;
  livesIn: string | null;
  owner: string | null;
  expiresAt: string | null;
  expiryNote: string | null;
  rotateHow: string | null;
  rotateHref: string | null;
  verifyWith: VerifyProvider | null;
  lastVerifiedAt: string | null;
  lastVerifyStatus: VerifyStatus | null;
  lastVerifyDetail: string | null;
  status: CredentialStatus;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export const CREDENTIAL_LIMITS = { name: 120, system: 120, livesIn: 200, owner: 80, note: 300, how: 300 } as const;

function text(value: unknown, max: number): string | null {
  const t = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  return t ? t.slice(0, max) : null;
}

/** True when the text carries something that looks like a secret value. The register never holds one. */
export function looksLikeSecret(value: string): boolean {
  return redactSecrets(value) !== value;
}

/** A Paperclip path or an https link; anything else (javascript:, data:, http) is refused. */
export function safeRotateHref(value: string): string | null {
  const href = value.trim();
  if (!href || /\s/.test(href)) return null;
  if (href.startsWith("/") && !href.startsWith("//")) return href;
  try {
    return new URL(href).protocol === "https:" ? new URL(href).toString() : null;
  } catch {
    return null;
  }
}

export interface CredentialInput {
  id: string | null;
  name: string | null;
  system: string | null;
  livesIn: string | null;
  owner: string | null;
  /** `YYYY-MM-DD`; `""` clears a known expiry. */
  expiresAt: string | null | "";
  expiryNote: string | null;
  rotateHow: string | null;
  rotateHref: string | null;
  verifyWith: VerifyProvider | "none" | null;
  status: CredentialStatus | null;
  notes: string | null;
  /** A person or agent checked it by hand just now. */
  markVerified: boolean;
}

/** Validates what an agent sent to `credential-record`. Refuses anything that looks like a secret. */
export function parseCredentialInput(raw: Record<string, unknown>): CredentialInput {
  const fields: Array<[string, unknown, number]> = [
    ["name", raw.name, CREDENTIAL_LIMITS.name],
    ["system", raw.system, CREDENTIAL_LIMITS.system],
    ["livesIn", raw.livesIn, CREDENTIAL_LIMITS.livesIn],
    ["owner", raw.owner, CREDENTIAL_LIMITS.owner],
    ["expiryNote", raw.expiryNote, CREDENTIAL_LIMITS.note],
    ["rotateHow", raw.rotateHow, CREDENTIAL_LIMITS.how],
    ["notes", raw.notes, CREDENTIAL_LIMITS.note],
  ];
  const got: Record<string, string | null> = {};
  for (const [field, value, max] of fields) {
    const t = text(value, max);
    if (t && looksLikeSecret(t)) throw new CredentialError(`${field} looks like it holds a secret (a key or token pattern, or a word such as token, key or password followed by : or =). The register holds names and places only (which secret, where it lives), never the value itself: say where it lives instead.`);
    got[field] = t;
  }
  let expiresAt: string | null | "" = null;
  if (raw.expiresAt === "" || raw.expiresAt === "none") expiresAt = "";
  else if (raw.expiresAt !== undefined && raw.expiresAt !== null) {
    const value = typeof raw.expiresAt === "string" ? raw.expiresAt.trim() : "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) throw new CredentialError("expiresAt must be a date as YYYY-MM-DD (or empty when it has none).");
    expiresAt = value;
  }
  let rotateHref: string | null = null;
  if (raw.rotateHref !== undefined && raw.rotateHref !== null && raw.rotateHref !== "") {
    rotateHref = typeof raw.rotateHref === "string" ? safeRotateHref(raw.rotateHref) : null;
    if (!rotateHref) throw new CredentialError("rotateHref must be a Paperclip path (/settings/...) or an https address.");
  }
  const verifyWith = raw.verifyWith === undefined || raw.verifyWith === null || raw.verifyWith === "" ? null : raw.verifyWith;
  if (verifyWith !== null && verifyWith !== "none" && !(VERIFY_PROVIDERS as readonly string[]).includes(String(verifyWith))) throw new CredentialError(`verifyWith must be one of ${VERIFY_PROVIDERS.join(", ")} (or none).`);
  const status = raw.status === undefined || raw.status === null || raw.status === "" ? null : raw.status;
  if (status !== null && !["active", "retired", "burned"].includes(String(status))) throw new CredentialError("status must be active, retired or burned (exposed: rotate it).");
  const id = text(raw.id, 40);
  if (!id && (!got.name || !got.system)) throw new CredentialError("A new credential needs name and system, for example name: \"Resend API key\", system: \"Resend\".");
  return {
    id,
    name: got.name!,
    system: got.system!,
    livesIn: got.livesIn!,
    owner: got.owner!,
    expiresAt,
    expiryNote: got.expiryNote!,
    rotateHow: got.rotateHow!,
    rotateHref,
    verifyWith: verifyWith as CredentialInput["verifyWith"],
    status: status as CredentialStatus | null,
    notes: got.notes!,
    markVerified: raw.markVerified === true,
  };
}

// ---------------------------------------------------------------------------
// Expiry and alerts
// ---------------------------------------------------------------------------

export type ExpiryState = "none" | "ok" | "warn" | "bad" | "expired";

export interface Expiry {
  state: ExpiryState;
  /** Whole days left (negative once passed); null with no expiry. */
  days: number | null;
}

export function expiryOf(row: Pick<CredentialRow, "expiresAt">, now: Date): Expiry {
  if (!row.expiresAt) return { state: "none", days: null };
  const days = Math.floor((Date.parse(row.expiresAt) - now.getTime()) / 86_400_000);
  if (!Number.isFinite(days)) return { state: "none", days: null };
  if (days < 0) return { state: "expired", days };
  if (days <= EXPIRY_BAD_DAYS) return { state: "bad", days };
  if (days <= EXPIRY_WARN_DAYS) return { state: "warn", days };
  return { state: "ok", days };
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Health checks for the register: an expiry at 30 / 7 days or past, a provider that refused the credential, and exposed credentials still in use. */
export function credentialChecks(rows: CredentialRow[], now: Date): HealthCheck[] {
  const out: HealthCheck[] = [];
  const how = (r: CredentialRow) => [r.rotateHow, r.rotateHref ? `link: ${r.rotateHref}` : null].filter(Boolean).join(". ");
  for (const row of rows.filter((r) => r.status !== "retired")) {
    const e = expiryOf(row, now);
    if (e.state === "warn" || e.state === "bad" || e.state === "expired") {
      out.push({
        key: `credential:${row.id}:expiry`,
        title: e.state === "expired" ? `${row.name} expired ${plural(-e.days!, "day")} ago` : `${row.name} expires in ${plural(e.days!, "day")}`,
        status: e.state === "warn" ? "warn" : "bad",
        detail: `${row.name} (${row.system}) ${e.state === "expired" ? "has expired" : `runs out on ${row.expiresAt!.slice(0, 10)}`}. ${row.livesIn ? `It lives in ${row.livesIn}. ` : ""}When it lapses, whatever uses it fails at once and nobody is told.`,
        href: row.rotateHref ?? "/cockpit",
        fix: how(row) || "Rotate it at the provider, then update where it lives and record the new expiry (credential-record).",
        // Only a lapsed one has a start of its own (the day it expired). An approaching expiry is in the future: giving it that
        // date as `since` would hold its age at zero until the day it lapses, and the 24 hour escalation to the System health
        // issue (health.ts warningAgeMs) would never fire. Left empty, the Cockpit ages it from the day it first saw it.
        since: e.state === "expired" ? row.expiresAt : undefined,
      });
    }
    if (row.lastVerifyStatus === "expired") {
      out.push({
        key: `credential:${row.id}:expired`,
        title: `${row.name} needs a new login`,
        status: "bad",
        detail: `The browser check could not use ${row.name}${row.lastVerifyDetail ? `: ${row.lastVerifyDetail}` : ""}. Whatever the browser does for it fails until someone logs in again.`,
        href: row.rotateHref ?? "/cockpit",
        fix: how(row) || "Log in again in the pib-browser profile on the server.",
        since: row.lastVerifiedAt,
      });
    }
    if (row.lastVerifyStatus === "invalid") {
      out.push({
        key: `credential:${row.id}:invalid`,
        title: `${row.system} refused ${row.name}`,
        status: "bad",
        detail: `The daily check called ${row.system} with ${row.name} and it was refused${row.lastVerifyDetail ? `: ${row.lastVerifyDetail}` : ""}. It is expired, revoked or wrong, so what depends on it is failing.`,
        href: row.rotateHref ?? "/cockpit",
        fix: how(row) || "Create a new one at the provider and update the company secret.",
        since: row.lastVerifiedAt,
      });
    }
  }
  const burned = rows.filter((r) => r.status === "burned");
  if (burned.length > 0) {
    out.push({
      key: "credentials:burned",
      title: `${plural(burned.length, "credential")} exposed and not yet replaced`,
      status: "warn",
      detail: `Marked burned (published or leaked): ${burned.slice(0, 6).map((r) => r.name).join("; ")}${burned.length > 6 ? "; ..." : ""}. A leaked credential stays dangerous until it is revoked.`,
      href: "/cockpit",
      fix: "Revoke each at its provider and rotate where it is used, then mark it retired with credential-record.",
    });
  }
  return out;
}

/** One row as the tool prints it: no value is ever stored, so none is ever printed. */
export function credentialBrief(row: CredentialRow, now: Date): Record<string, unknown> {
  const e = expiryOf(row, now);
  return {
    id: row.id,
    name: row.name,
    system: row.system,
    status: row.status,
    owner: row.owner,
    livesIn: row.livesIn,
    expiresAt: row.expiresAt?.slice(0, 10) ?? null,
    expiry: e.state === "none" ? (row.expiryNote ?? "unknown") : e.state === "expired" ? `expired ${plural(-e.days!, "day")} ago` : `${plural(e.days!, "day")} left`,
    rotate: row.rotateHow,
    rotateHref: row.rotateHref,
    verifyWith: row.verifyWith,
    lastVerifiedAt: row.lastVerifiedAt?.slice(0, 10) ?? null,
    lastVerify: row.lastVerifyStatus ? `${row.lastVerifyStatus}${row.lastVerifyDetail ? `: ${row.lastVerifyDetail}` : ""}` : null,
    notes: row.notes,
  };
}

// ---------------------------------------------------------------------------
// The pib-browser status file (credentials provider "browser")
// ---------------------------------------------------------------------------

/** The status file is written by `pib-evidence status` roughly daily; older than this and nobody vouches for the logins. */
export const BROWSER_STATUS_MAX_AGE_MS = 36 * 3_600_000;
export const BROWSER_SEED_PREFIX = "browser:";
const IDENTITY = /^[a-z0-9][a-z0-9:_.-]{0,79}$/;

export interface BrowserIdentity {
  identity: string;
  ok: boolean;
  /** A short code or words: never a page body. Redacted and cut. */
  reason: string;
}

export type BrowserStatus =
  | { state: "missing" }
  | { state: "invalid" }
  | { state: "read"; checkedAt: string; stale: boolean; identities: BrowserIdentity[] };

/** Parses the file's text. Never throws; a file that is not the expected shape is `invalid`, an absent one `missing`. */
export function parseBrowserStatus(text: string | null, now: Date): BrowserStatus {
  if (text === null || text.trim() === "") return { state: "missing" };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { state: "invalid" };
  }
  const obj = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  const checked = typeof obj?.checkedAt === "string" ? Date.parse(obj.checkedAt) : NaN;
  const list = obj?.identities;
  if (!obj || !Number.isFinite(checked) || !list || typeof list !== "object" || Array.isArray(list)) return { state: "invalid" };
  const identities: BrowserIdentity[] = [];
  for (const [identity, entry] of Object.entries(list as Record<string, unknown>).slice(0, 50)) {
    if (!IDENTITY.test(identity) || !entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const reason = text_(e.reason, 80);
    identities.push({ identity, ok: e.ok === true, reason: looksLikeSecret(reason) ? "" : reason });
  }
  return { state: "read", checkedAt: new Date(checked).toISOString(), stale: now.getTime() - checked > BROWSER_STATUS_MAX_AGE_MS, identities };
}

function text_(value: unknown, max: number): string {
  return text(value, max)?.replace(/[^\w .:,-]/g, "") ?? "";
}

/** What the register records for one identity: ok only when the file is fresh and says so; otherwise expired, with the reason. */
export function browserVerdict(status: Extract<BrowserStatus, { state: "read" }>, id: BrowserIdentity): { status: "ok" | "expired"; detail: string } {
  if (status.stale) return { status: "expired", detail: "The browser status file is more than 36 hours old, so this login is not vouched for." };
  if (!id.ok) return { status: "expired", detail: id.reason ? `The browser could not use this login (${id.reason}).` : "The browser could not use this login." };
  return { status: "ok", detail: "The browser used this login at the last check." };
}
