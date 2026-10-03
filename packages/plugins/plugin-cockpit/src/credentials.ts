/**
 * The credentials register, worker part: the table, the seed, the daily check
 * and the two tools' logic. The rules and the alerts are in
 * `credentials-model.ts`.
 *
 * Verifying. A row may name a provider (`verifyWith`: github, cloudflare,
 * resend). The Cockpit settings hold one optional company-secret picker per
 * provider (`credentialChecks.<provider>`); the daily job resolves the secret,
 * makes ONE cheap GET to the provider with it and records only the verdict
 * (ok / invalid / unreachable) and, when the provider says it, the expiry. The
 * value is never stored, logged or returned, and a response body is never kept.
 */
import { randomBytes } from "node:crypto";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { configSaved, readConfig, SecretResolver } from "@partnersinbiz/pib-plugin-kit";
import { recordActivity } from "./activity.js";
import { CREDENTIAL_SEED } from "./credentials-seed.js";
import {
  CredentialError,
  credentialBrief,
  credentialChecks,
  parseCredentialInput,
  type CredentialRow,
  type CredentialStatus,
  type VerifyProvider,
  type VerifyStatus,
} from "./credentials-model.js";
import { getRoles, listRoles } from "./db.js";
import type { Env } from "./env.js";
import { message, throwIfEveryCompanyFailed } from "./env.js";
import { refreshHealthIssue } from "./health.js";
import { NAMESPACE } from "./namespace.js";

const T = `${NAMESPACE}.credentials`;
type Raw = Record<string, unknown>;

const COLUMNS =
  "id, company_id, seed_key, name, system, lives_in, owner, expires_at, expiry_note, rotate_how, rotate_href, verify_with, last_verified_at, last_verify_status, last_verify_detail, status, notes, created_at, updated_at";

const str = (value: unknown): string | null => (value == null || value === "" ? null : String(value));
const iso = (value: unknown): string | null => {
  if (value instanceof Date) return value.toISOString();
  if (value == null || value === "") return null;
  const t = Date.parse(String(value));
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};

function rowFrom(r: Raw): CredentialRow {
  return {
    id: String(r.id),
    companyId: String(r.company_id),
    seedKey: str(r.seed_key),
    name: String(r.name ?? ""),
    system: String(r.system ?? ""),
    livesIn: str(r.lives_in),
    owner: str(r.owner),
    expiresAt: iso(r.expires_at),
    expiryNote: str(r.expiry_note),
    rotateHow: str(r.rotate_how),
    rotateHref: str(r.rotate_href),
    verifyWith: str(r.verify_with) as VerifyProvider | null,
    lastVerifiedAt: iso(r.last_verified_at),
    lastVerifyStatus: str(r.last_verify_status) as VerifyStatus | null,
    lastVerifyDetail: str(r.last_verify_detail),
    status: String(r.status) as CredentialStatus,
    notes: str(r.notes),
    createdAt: iso(r.created_at) ?? "",
    updatedAt: iso(r.updated_at) ?? "",
  };
}

const newId = (): string => `cred${randomBytes(6).toString("hex")}`;

export async function listCredentials(ctx: PluginContext, companyId: string): Promise<CredentialRow[]> {
  const rows = await ctx.db.query<Raw>(`SELECT ${COLUMNS} FROM ${T} WHERE company_id = $1 ORDER BY name LIMIT 300`, [companyId]);
  return rows.map(rowFrom);
}

export async function getCredential(ctx: PluginContext, companyId: string, id: string): Promise<CredentialRow | null> {
  const rows = await ctx.db.query<Raw>(`SELECT ${COLUMNS} FROM ${T} WHERE company_id = $1 AND id = $2`, [companyId, id]);
  return rows[0] ? rowFrom(rows[0]) : null;
}

// ---------------------------------------------------------------------------
// Seed
// ---------------------------------------------------------------------------

/**
 * Whether the starting list belongs in this company's register: only where the
 * Cockpit setting `credentialSeed` is ticked, which is Partners in Biz's own
 * company and nobody else's. The list describes PiB's infrastructure (server
 * paths, where the burned tokens and the backup key live), so a client company
 * must never receive it, nor its "exposed credentials" warning. Default off.
 */
export async function seedEnabled(ctx: PluginContext, companyId: string): Promise<boolean> {
  try {
    return (await readConfig(ctx, companyId)).credentialSeed === true;
  } catch {
    return false;
  }
}

/**
 * Adds the rows of the security table the company does not have yet (by seed
 * key). Returns how many it added: 0 for every company that has not ticked
 * `credentialSeed`, whoever calls it.
 */
export async function seedCredentials(env: Env, companyId: string): Promise<number> {
  if (!(await seedEnabled(env.ctx, companyId))) return 0;
  const now = env.now().toISOString();
  let added = 0;
  for (const seed of CREDENTIAL_SEED) {
    const result = await env.ctx.db.execute(
      `INSERT INTO ${T} (id, company_id, seed_key, name, system, lives_in, owner, expires_at, expiry_note, rotate_how, rotate_href, verify_with, status, notes, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16) ON CONFLICT (company_id, seed_key) WHERE seed_key IS NOT NULL DO NOTHING`,
      [newId(), companyId, seed.seedKey, seed.name, seed.system, seed.livesIn, "Owner", seed.expiresAt, seed.expiryNote, seed.rotateHow, seed.rotateHref, seed.verifyWith, seed.status, seed.notes, now, now],
    );
    added += result.rowCount ?? 0;
  }
  return added;
}

// ---------------------------------------------------------------------------
// credential-record
// ---------------------------------------------------------------------------

/**
 * Marking a credential verified and changing its status are what silence the
 * alarms (a provider's "refused" verdict, an exposed credential still listed).
 * Any agent may add a credential and fix its details, but only the Operator
 * may vouch for one or retire it: an agent steered by text in an issue must not
 * be able to clear them.
 */
async function requireOperatorForAlarms(env: Env, companyId: string, actor: { agentId: string | null }, input: { markVerified: boolean; status: CredentialStatus | null }): Promise<void> {
  if (!actor.agentId || (!input.markVerified && input.status === null)) return;
  const operator = (await getRoles(env.ctx, companyId).catch(() => null))?.operatorAgentId ?? null;
  if (operator && actor.agentId === operator) return;
  throw new CredentialError("Only the Operator can mark a credential verified or change its status (retired, burned, active): those clear the alerts. Record the details you know (expiry, where it lives, how to rotate) and hand this to the Operator, or ask the owner.");
}

export async function recordCredential(env: Env, companyId: string, raw: Record<string, unknown>, actor: { agentId: string | null; userId: string | null }): Promise<{ credential: CredentialRow; created: boolean; message: string }> {
  const input = parseCredentialInput(raw);
  await requireOperatorForAlarms(env, companyId, actor, input);
  const now = env.now().toISOString();
  const by = actor.agentId ? `agent ${actor.agentId.slice(0, 8)}` : actor.userId ? "the owner" : "someone";
  if (input.id) {
    const row = await getCredential(env.ctx, companyId, input.id);
    if (!row) throw new CredentialError(`Credential ${input.id} was not found in this company.`);
    const verifyWith = input.verifyWith === "none" ? null : input.verifyWith ?? row.verifyWith;
    const expiresAt = input.expiresAt === "" ? null : input.expiresAt ?? row.expiresAt;
    await env.ctx.db.execute(
      `UPDATE ${T} SET name = $3, system = $4, lives_in = $5, owner = $6, expires_at = $7, expiry_note = $8, rotate_how = $9, rotate_href = $10, verify_with = $11, status = $12, notes = $13,
              last_verified_at = $14, last_verify_status = $15, last_verify_detail = $16, updated_at = $17 WHERE company_id = $1 AND id = $2`,
      [
        companyId, row.id, input.name ?? row.name, input.system ?? row.system, input.livesIn ?? row.livesIn, input.owner ?? row.owner, expiresAt, input.expiryNote ?? row.expiryNote,
        input.rotateHow ?? row.rotateHow, input.rotateHref ?? row.rotateHref, verifyWith, input.status ?? row.status, input.notes ?? row.notes,
        input.markVerified ? now : row.lastVerifiedAt, input.markVerified ? "ok" : row.lastVerifyStatus, input.markVerified ? `Confirmed by ${by} on ${now.slice(0, 10)}` : row.lastVerifyDetail, now,
      ],
    );
    if (input.markVerified && row.lastVerifyStatus === "invalid") {
      // Said in the activity feed: a provider's refusal was vouched away by hand.
      await recordActivity(env.ctx, companyId, { key: `credential:${row.id}:vouched:${now.slice(0, 10)}`, kind: "credential", at: now, text: `${by} marked ${row.name} verified although ${row.system} refused it at the last check`, href: "/cockpit", agentId: actor.agentId }).catch(() => false);
    }
    return { credential: (await getCredential(env.ctx, companyId, row.id))!, created: false, message: `Updated "${input.name ?? row.name}".` };
  }
  const id = newId();
  await env.ctx.db.execute(
    `INSERT INTO ${T} (id, company_id, name, system, lives_in, owner, expires_at, expiry_note, rotate_how, rotate_href, verify_with, status, notes, last_verified_at, last_verify_status, last_verify_detail, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`,
    [
      id, companyId, input.name, input.system, input.livesIn, input.owner, input.expiresAt === "" ? null : input.expiresAt, input.expiryNote, input.rotateHow, input.rotateHref,
      input.verifyWith === "none" ? null : input.verifyWith, input.status ?? "active", input.notes, input.markVerified ? now : null, input.markVerified ? "ok" : null, input.markVerified ? `Confirmed by ${by} on ${now.slice(0, 10)}` : null, now, now,
    ],
  );
  return { credential: (await getCredential(env.ctx, companyId, id))!, created: true, message: `Recorded "${input.name}". The register keeps names and places only: the secret itself stays where it lives.` };
}

// ---------------------------------------------------------------------------
// Verifying with the provider
// ---------------------------------------------------------------------------

export interface VerifyResult {
  status: VerifyStatus;
  /** Words only: no body, no token. */
  detail: string;
  /** What the provider says the expiry is, `YYYY-MM-DD`. */
  expiresAt?: string | null;
}

type FetchLike = (url: string, init?: Record<string, unknown>) => Promise<{ status: number; headers: { get(name: string): string | null }; json(): Promise<unknown> }>;

const TIMEOUT_MS = 10_000;

async function call(fetchImpl: FetchLike, url: string, headers: Record<string, string>): Promise<{ status: number; headers: { get(name: string): string | null }; json(): Promise<unknown> } | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      return await fetchImpl(url, { method: "GET", headers: { "user-agent": "partnersinbiz-cockpit", accept: "application/json", ...headers }, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return null;
  }
}

/** The response body as JSON, or null when it is not (a body is only ever read for a status word, never kept). */
async function readJson<T>(res: { json(): Promise<unknown> }): Promise<T | null> {
  try {
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/** The date part of a provider's expiry text (`2027-09-29 00:00:00 UTC`). */
function dateOnly(value: string | null | undefined): string | null {
  const m = value ? /(\d{4}-\d{2}-\d{2})/.exec(value) : null;
  return m && !Number.isNaN(Date.parse(`${m[1]}T00:00:00Z`)) ? m[1]! : null;
}

export const VERIFIERS: Record<VerifyProvider, (token: string, fetchImpl: FetchLike) => Promise<VerifyResult>> = {
  // GET /user answers 200 for a live token and sends its expiry in a header.
  async github(token, fetchImpl) {
    const res = await call(fetchImpl, "https://api.github.com/user", { authorization: `Bearer ${token}`, "x-github-api-version": "2022-11-28" });
    if (!res) return { status: "unreachable", detail: "GitHub did not answer." };
    if (res.status === 401) return { status: "invalid", detail: "GitHub refused it (expired or revoked)." };
    if (res.status >= 500 || res.status === 429) return { status: "unreachable", detail: `GitHub answered ${res.status}.` };
    if (res.status === 200) return { status: "ok", detail: "GitHub accepts it.", expiresAt: dateOnly(res.headers.get("github-authentication-token-expiration")) };
    return { status: "unreachable", detail: `GitHub answered ${res.status}, so it could not tell.` };
  },
  async cloudflare(token, fetchImpl) {
    const res = await call(fetchImpl, "https://api.cloudflare.com/client/v4/user/tokens/verify", { authorization: `Bearer ${token}` });
    if (!res) return { status: "unreachable", detail: "Cloudflare did not answer." };
    if (res.status === 401 || res.status === 403) return { status: "invalid", detail: "Cloudflare refused it." };
    if (res.status >= 500 || res.status === 429) return { status: "unreachable", detail: `Cloudflare answered ${res.status}.` };
    const body = await readJson<{ success?: boolean; result?: { status?: string; expires_on?: string } }>(res);
    if (res.status === 200 && body?.success && body.result?.status === "active") return { status: "ok", detail: "Cloudflare says the token is active.", expiresAt: dateOnly(body.result.expires_on) };
    if (res.status === 200 && body?.result?.status) return { status: "invalid", detail: `Cloudflare says the token is ${String(body.result.status).slice(0, 20)}.` };
    return { status: "unreachable", detail: `Cloudflare answered ${res.status}, so it could not tell.` };
  },
  // GET /domains needs a full-access key; a sending-only key is refused with a "restricted" error, which still proves the key is live.
  async resend(token, fetchImpl) {
    const res = await call(fetchImpl, "https://api.resend.com/domains", { authorization: `Bearer ${token}` });
    if (!res) return { status: "unreachable", detail: "Resend did not answer." };
    if (res.status === 200) return { status: "ok", detail: "Resend accepts it." };
    if (res.status >= 500 || res.status === 429) return { status: "unreachable", detail: `Resend answered ${res.status}.` };
    if (res.status === 401 || res.status === 403) {
      const name = String((await readJson<{ name?: unknown }>(res))?.name ?? "");
      return name === "restricted_api_key" ? { status: "ok", detail: "Resend accepts it (a sending-only key)." } : { status: "invalid", detail: "Resend refused it." };
    }
    return { status: "unreachable", detail: `Resend answered ${res.status}, so it could not tell.` };
  },
};

export const VERIFY_SECRET_PATH = (provider: VerifyProvider): string => `credentialChecks.${provider}`;

/**
 * Verifies one row. `not_configured` when its provider's secret is not set in
 * the Cockpit settings, `unsupported` when the row names no provider. The
 * secret is resolved here, used for one call and dropped.
 */
export async function verifyCredential(env: Env, companyId: string, row: CredentialRow, secrets: SecretResolver): Promise<VerifyResult> {
  if (!row.verifyWith) return { status: "unsupported", detail: "No provider check exists for this one." };
  const verifier = VERIFIERS[row.verifyWith];
  if (!verifier) return { status: "unsupported", detail: "No provider check exists for this one." };
  let token: string | undefined;
  try {
    token = await secrets.get(VERIFY_SECRET_PATH(row.verifyWith));
  } catch (error) {
    // The error can name a secret reference, never its value; keep it short.
    return { status: "not_configured", detail: `The settings secret could not be read (${message(error).slice(0, 80)}).` };
  }
  if (!token) return { status: "not_configured", detail: `Pick a company secret under Credential checks → ${row.verifyWith} in the Cockpit settings so the daily check can call ${row.system}.` };
  return verifier(token, (env.fetchImpl ?? fetch) as unknown as FetchLike);
}

/** How many credentials one run calls out for (a provider is never hammered). */
const MAX_VERIFY_PER_RUN = 12;

export interface CheckResult {
  seeded: number;
  verified: number;
  ok: number;
  invalid: number;
  unreachable: number;
  notConfigured: number;
}

/** Verifies the rows that name a provider, recording the verdict (and the provider's expiry when it gave one). */
export async function verifyCompany(env: Env, companyId: string, options: { only?: string[]; skipCheckedWithinMs?: number } = {}): Promise<CheckResult & { skippedRecent: number }> {
  const result: CheckResult & { skippedRecent: number } = { seeded: 0, verified: 0, ok: 0, invalid: 0, unreachable: 0, notConfigured: 0, skippedRecent: 0 };
  const config = await readConfig(env.ctx, companyId);
  const secrets = new SecretResolver(env.ctx, companyId, config);
  const nowDate = env.now();
  const now = nowDate.toISOString();
  const candidates = (await listCredentials(env.ctx, companyId)).filter((r) => r.status !== "retired" && r.verifyWith && (!options.only || options.only.includes(r.id)));
  // A tool call may ask for a fresh check, but a provider is not called again for a credential that was really checked a moment ago.
  const recent = (r: CredentialRow) => options.skipCheckedWithinMs !== undefined && (r.lastVerifyStatus === "ok" || r.lastVerifyStatus === "invalid") && !!r.lastVerifiedAt && nowDate.getTime() - Date.parse(r.lastVerifiedAt) < options.skipCheckedWithinMs;
  result.skippedRecent = candidates.filter(recent).length;
  const rows = candidates.filter((r) => !recent(r)).slice(0, MAX_VERIFY_PER_RUN);
  for (const row of rows) {
    const verdict = await verifyCredential(env, companyId, row, secrets);
    if (verdict.status === "not_configured") result.notConfigured += 1;
    else {
      result.verified += 1;
      if (verdict.status === "ok") result.ok += 1;
      else if (verdict.status === "invalid") result.invalid += 1;
      else if (verdict.status === "unreachable") result.unreachable += 1;
    }
    // Neither an unreachable provider nor a missing secret says anything about the credential: keep the last REAL verdict exactly as it was
    // (status, words and date), so the register never shows a fresh "last verified" date or a verdict that was not checked.
    const real = row.lastVerifyStatus === "ok" || row.lastVerifyStatus === "invalid";
    if (verdict.status === "unreachable" || verdict.status === "unsupported" || (verdict.status === "not_configured" && real)) continue;
    await env.ctx.db.execute(
      `UPDATE ${T} SET last_verified_at = $3, last_verify_status = $4, last_verify_detail = $5, expires_at = $6, updated_at = $7 WHERE company_id = $1 AND id = $2`,
      [companyId, row.id, verdict.status === "not_configured" ? null : now, verdict.status, verdict.detail.slice(0, 200), verdict.expiresAt ? `${verdict.expiresAt}T00:00:00.000Z` : row.expiresAt, now],
    );
    if (verdict.status === "invalid" && row.lastVerifyStatus !== "invalid") {
      await recordActivity(env.ctx, companyId, { key: `credential:${row.id}:invalid:${now.slice(0, 10)}`, kind: "credential", at: now, text: `${row.system} refused ${row.name}`, href: "/cockpit", agentId: null }).catch(() => false);
    }
  }
  return result;
}

/** What a tool call or the page shows: every row, as the register keeps it. */
export async function credentialList(env: Env, companyId: string, options: { includeRetired?: boolean } = {}): Promise<{ credentials: Array<Record<string, unknown>>; problems: ReturnType<typeof credentialChecks> }> {
  const now = env.now();
  const all = await listCredentials(env.ctx, companyId);
  const rows = options.includeRetired ? all : all.filter((r) => r.status !== "retired");
  return { credentials: rows.map((r) => credentialBrief(r, now)), problems: credentialChecks(all, now) };
}

/** Health checks for the register (the snapshot reads them; no provider is called). */
export async function credentialHealth(env: Env, companyId: string): Promise<ReturnType<typeof credentialChecks>> {
  try {
    return credentialChecks(await listCredentials(env.ctx, companyId), env.now());
  } catch (error) {
    env.ctx.logger.info("Cockpit credential register unreadable", { companyId, error: message(error) });
    return [];
  }
}

/** Daily job: verify and settle the alerts for every company with saved Cockpit settings, and load the starting list where `credentialSeed` is ticked. */
export async function credentialsCheck(env: Env): Promise<Record<string, number>> {
  const total: Record<string, number> = { companies: 0, seeded: 0, verified: 0, ok: 0, invalid: 0, unreachable: 0, notConfigured: 0, failed: 0 };
  for (const row of await listRoles(env.ctx)) {
    if (!(await configSaved(env.ctx, row.companyId))) continue;
    total.companies = (total.companies ?? 0) + 1;
    try {
      const seeded = await seedCredentials(env, row.companyId);
      const r = await verifyCompany(env, row.companyId);
      r.seeded = seeded;
      for (const [key, value] of Object.entries(r)) total[key] = (total[key] ?? 0) + value;
      // Put a new alert on the System health issue now, not at the next hour.
      await refreshHealthIssue(env, row.companyId).catch((error) => env.ctx.logger.info("Credential check: health refresh failed", { error: message(error) }));
    } catch (error) {
      total.failed = (total.failed ?? 0) + 1;
      env.ctx.logger.info("Credential check failed for a company", { companyId: row.companyId, error: message(error) });
    }
  }
  throwIfEveryCompanyFailed("The credentials check", total.companies ?? 0, total.failed ?? 0);
  return total;
}
