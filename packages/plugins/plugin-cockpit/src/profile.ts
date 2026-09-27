/**
 * The company profile (migration 003 `company_profile`): the worker side.
 * People edit any field on the Cockpit's Profile tab (`profile.save`);
 * agents read it with `company-profile` and fill empty fields with
 * `update-company-profile`.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { NAMESPACE } from "./namespace.js";
import { PROFILE_PATH } from "./constants.js";
import {
  applyEdit,
  CORE_PROFILE_FIELDS,
  fieldLabels,
  fillEmpty,
  missingFields,
  parseProfile,
  profileField,
  PROFILE_FIELDS,
  type CompanyProfile,
  type FilledBy,
  type FillResult,
  type ProfileFieldKey,
} from "./profile-model.js";

const TABLE = `${NAMESPACE}.company_profile`;

export interface StoredProfile {
  profile: CompanyProfile;
  filledBy: FilledBy;
  updatedAt: string | null;
}

function json(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function parseFilledBy(value: unknown): FilledBy {
  const source = json(value);
  if (!source || typeof source !== "object" || Array.isArray(source)) return {};
  const out: FilledBy = {};
  for (const [key, raw] of Object.entries(source as Record<string, unknown>)) {
    const field = profileField(key);
    const entry = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
    if (!field || !entry || (entry.by !== "person" && entry.by !== "agent")) continue;
    out[field.key] = { by: entry.by, id: typeof entry.id === "string" ? entry.id : null, at: typeof entry.at === "string" ? entry.at : "" };
  }
  return out;
}

export async function readProfile(ctx: PluginContext, companyId: string): Promise<StoredProfile> {
  const rows = await ctx.db.query<Record<string, unknown>>(`SELECT profile, filled_by, updated_at FROM ${TABLE} WHERE company_id = $1`, [companyId]);
  const row = rows[0];
  if (!row) return { profile: {}, filledBy: {}, updatedAt: null };
  const updated = row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at == null ? null : String(row.updated_at);
  return { profile: parseProfile(json(row.profile)), filledBy: parseFilledBy(row.filled_by), updatedAt: updated };
}

async function writeProfile(ctx: PluginContext, companyId: string, profile: CompanyProfile, filledBy: FilledBy, now: string): Promise<void> {
  await ctx.db.execute(
    `INSERT INTO ${TABLE} (company_id, profile, filled_by, updated_at) VALUES ($1, $2::jsonb, $3::jsonb, $4)
     ON CONFLICT (company_id) DO UPDATE SET profile = EXCLUDED.profile, filled_by = EXCLUDED.filled_by, updated_at = EXCLUDED.updated_at`,
    [companyId, JSON.stringify(profile), JSON.stringify(filledBy), now],
  );
}

/** A person saves the Profile tab: any field may be set or cleared. */
export async function saveProfileEdit(ctx: PluginContext, companyId: string, input: Record<string, unknown>, userId: string | null, now: string): Promise<StoredProfile & { changed: ProfileFieldKey[] }> {
  const current = await readProfile(ctx, companyId);
  const { profile, changed } = applyEdit(current.profile, input);
  if (changed.length === 0) return { ...current, changed };
  const filledBy: FilledBy = { ...current.filledBy };
  for (const key of changed) {
    if (profile[key] === undefined) delete filledBy[key];
    else filledBy[key] = { by: "person", id: userId, at: now };
  }
  await writeProfile(ctx, companyId, profile, filledBy, now);
  return { profile, filledBy, updatedAt: now, changed };
}

/** An agent fills empty fields (`update-company-profile`); set values stay as they are. */
export async function fillProfile(ctx: PluginContext, companyId: string, input: Record<string, unknown>, agentId: string | null, now: string): Promise<FillResult> {
  const current = await readProfile(ctx, companyId);
  const result = fillEmpty(current.profile, input);
  if (result.filled.length) {
    const filledBy: FilledBy = { ...current.filledBy };
    for (const key of result.filled) filledBy[key] = { by: "agent", id: agentId, at: now };
    await writeProfile(ctx, companyId, result.profile, filledBy, now);
  }
  return result;
}

/** What `company-profile` returns: the profile, what is missing and where people edit it. */
export function profileSummary(stored: StoredProfile, link: (href: string) => string) {
  const missing = missingFields(stored.profile);
  const coreMissing = CORE_PROFILE_FIELDS.filter((key) => missing.includes(key));
  const content = missing.length === 0
    ? "Company profile: every field is set."
    : `Company profile: ${PROFILE_FIELDS.length - missing.length} of ${PROFILE_FIELDS.length} fields set. Missing: ${fieldLabels(missing)}.${coreMissing.length ? " Fill what you can find (website, past work) with update-company-profile; the owner can change it on the Profile tab." : ""}`;
  return {
    content,
    data: {
      profile: stored.profile,
      missing,
      filledByAgents: Object.entries(stored.filledBy).filter(([, v]) => v?.by === "agent").map(([key]) => key),
      updatedAt: stored.updatedAt,
      href: link(PROFILE_PATH),
    },
  };
}

/** The setup item: done once the fields agents need to write in the company's name are set. */
export function profileSetupItem(profile: CompanyProfile) {
  const coreMissing = CORE_PROFILE_FIELDS.filter((key) => missingFields(profile, [key]).length > 0);
  return {
    key: "company_profile",
    title: "Fill in the company profile",
    status: coreMissing.length === 0 ? ("done" as const) : ("missing" as const),
    required: true,
    detail: coreMissing.length === 0
      ? "Agents use it for the sender, brand voice and banned words in every post, email, invoice and quote."
      : `Agents need the ${fieldLabels(coreMissing)} before they write in the company's name. The Operator can draft empty fields from the website; you check them.`,
    href: PROFILE_PATH,
    hrefLabel: "Open the profile",
    steps: coreMissing.length === 0 ? undefined : ["Open Cockpit → Profile.", `Fill in the ${fieldLabels(coreMissing)} (the other fields help too).`, "Click Save profile."],
    agentNext: "Posts, emails, invoices and quotes use the company's own name, sender, voice and banned words.",
  };
}
