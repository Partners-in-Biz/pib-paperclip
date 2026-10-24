/**
 * Company preferences: the settings a company owner or admin edits without
 * being an instance admin. Platform config (keys, URLs, secrets) stays in the
 * host's plugin settings form; only person-facing choices live here.
 *
 * Storage: one `ctx.state` row per company (scopeKind `company`, namespace
 * `preferences`, key `v1`). Only explicitly set values are stored, so defaults
 * are computed at read time. Reading needs no role; writing fails closed.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { readConfig, valueAtPath } from "./config.js";
import { LOCAL_BOARD_USER_ID } from "./cockpit.js";

/** The host does not cap state rows, so the kit does (serialized JSON bytes). */
export const PREFERENCES_MAX_BYTES = 16384;

const NAMESPACE = "preferences";
const STATE_KEY = "v1";
const SECRET_LIKE = /secret|token|key|password|private/i;
const FIELD_ID = /^[A-Za-z][A-Za-z0-9_.]*$/;
const DEFAULT_MAX = { string: 500, text: 5000 } as const;

export type PreferenceValue = string | number | boolean;
export type PreferenceValues = Record<string, PreferenceValue>;
export type DefaultContext = { companyName: string; shortName: string };
type Legacy = string | ((rawSavedConfig: Record<string, unknown>) => unknown);
type Base<T> = { label: string; help?: string; default: T | ((c: DefaultContext) => T); legacy?: Legacy };

export type PreferenceField =
  | (Base<string> & { type: "string" | "text"; max?: number })
  | (Base<boolean> & { type: "bool" })
  | (Base<number> & { type: "int"; min?: number; max?: number })
  | (Base<string> & { type: "enum"; options: readonly string[] });

export type PreferencesSchema = {
  id: string;
  fields: Record<string, PreferenceField>;
  /** Old defaults the instance's own company keeps, e.g. `{ labelPrefix: "PiB" }`. */
  ownCompanyPins: PreferenceValues;
  /** The one company that gets a seed row. No rule means nobody is seeded. */
  isOwnCompany?: (ctx: PluginContext, companyId: string, rawSavedConfig: Record<string, unknown>) => boolean | Promise<boolean>;
};

export function definePreferences(input: {
  id: string;
  fields: Record<string, PreferenceField>;
  ownCompanyPins?: PreferenceValues;
  isOwnCompany?: PreferencesSchema["isOwnCompany"];
}): PreferencesSchema {
  if (!input.id.trim()) throw new Error("Preferences need an id");
  for (const [id, field] of Object.entries(input.fields)) {
    if (!FIELD_ID.test(id)) throw new Error(`Preference field "${id}" must start with a letter and use letters, digits, "_" or "."`);
    if (SECRET_LIKE.test(id)) throw new Error(`Preference field "${id}" looks like a secret; secrets stay in the plugin settings`);
    if (field.type === "enum" && field.options.length === 0) throw new Error(`Preference field "${id}" needs options`);
    if (typeof field.default !== "function" && checkValue(field, field.default) !== null) {
      throw new Error(`Default of preference field "${id}" is not valid: ${checkValue(field, field.default)}`);
    }
  }
  const ownCompanyPins = input.ownCompanyPins ?? {};
  for (const [id, value] of Object.entries(ownCompanyPins)) {
    const field = Object.hasOwn(input.fields, id) ? input.fields[id] : undefined;
    if (!field) throw new Error(`Pin "${id}" is not a preference field`);
    if (checkValue(field, value) !== null) throw new Error(`Pin "${id}" is not valid: ${checkValue(field, value)}`);
  }
  return { id: input.id, fields: input.fields, ownCompanyPins, isOwnCompany: input.isOwnCompany };
}

/** Error text, or null when the value fits the field. */
function checkValue(field: PreferenceField, value: unknown): string | null {
  switch (field.type) {
    case "string":
    case "text": {
      if (typeof value !== "string") return "must be text";
      const max = field.max ?? DEFAULT_MAX[field.type];
      return value.length > max ? `must be at most ${max} characters` : null;
    }
    case "bool":
      return typeof value === "boolean" ? null : "must be true or false";
    case "int": {
      if (typeof value !== "number" || !Number.isInteger(value)) return "must be a whole number";
      if (field.min !== undefined && value < field.min) return `must be at least ${field.min}`;
      if (field.max !== undefined && value > field.max) return `must be at most ${field.max}`;
      return null;
    }
    case "enum":
      return typeof value === "string" && field.options.includes(value) ? null : `must be one of: ${field.options.join(", ")}`;
  }
}

type Row = { values: PreferenceValues; updatedBy: string | null; updatedAt: string };

function scope(companyId: string) {
  return { scopeKind: "company" as const, scopeId: companyId, namespace: NAMESPACE, stateKey: STATE_KEY };
}

async function getRow(ctx: PluginContext, companyId: string): Promise<Row | null> {
  const stored = await ctx.state.get(scope(companyId));
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) return null;
  const values = (stored as { values?: unknown }).values;
  if (!values || typeof values !== "object" || Array.isArray(values)) return null;
  const row = stored as Partial<Row>;
  return { values: values as PreferenceValues, updatedBy: row.updatedBy ?? null, updatedAt: row.updatedAt ?? "" };
}

async function rawConfig(ctx: PluginContext, companyId: string): Promise<Record<string, unknown>> {
  try {
    return await readConfig(ctx, companyId);
  } catch {
    return {};
  }
}

/** Valid, explicitly saved legacy values from the RAW saved config (no defaults applied). */
function legacyValues(schema: PreferencesSchema, raw: Record<string, unknown>): PreferenceValues {
  const out: PreferenceValues = {};
  for (const [id, field] of Object.entries(schema.fields)) {
    if (!field.legacy) continue;
    try {
      const value = typeof field.legacy === "string" ? valueAtPath(raw, field.legacy) : field.legacy(raw);
      if (value !== undefined && value !== null && checkValue(field, value) === null) out[id] = value as PreferenceValue;
    } catch {
      // Legacy function threw; skip this field
    }
  }
  return out;
}

async function defaultContext(ctx: PluginContext, companyId: string): Promise<DefaultContext> {
  let name = "";
  let prefix = "";
  try {
    const company = await ctx.companies.get(companyId);
    name = company?.name?.trim() ?? "";
    prefix = company?.issuePrefix?.trim() ?? "";
  } catch {
    // companies.read missing or refused: defaults fall back to empty text.
  }
  return { companyName: name, shortName: prefix || name.replace(/[^A-Za-z0-9 ]/g, "").trim() };
}

async function effective(ctx: PluginContext, companyId: string, schema: PreferencesSchema, row: Row | null, raw: Record<string, unknown>): Promise<PreferenceValues> {
  const legacy = legacyValues(schema, raw);
  let defaultsFor: DefaultContext | null = null;
  const out: PreferenceValues = {};
  for (const [id, field] of Object.entries(schema.fields)) {
    const own = row && Object.hasOwn(row.values, id) ? row.values[id] : undefined;
    if (own !== undefined && checkValue(field, own) === null) out[id] = own;
    else if (id in legacy) out[id] = legacy[id]!;
    else if (typeof field.default === "function") {
      defaultsFor ??= await defaultContext(ctx, companyId);
      out[id] = (field.default as (c: DefaultContext) => PreferenceValue)(defaultsFor);
    } else out[id] = field.default;
  }
  return out;
}

/**
 * Own company with no row yet: write the row from saved legacy values plus the
 * pins. Re-reads first and skips if a row exists, so a first save is never
 * overwritten. Never throws: reading must work without `plugin.state.write`,
 * in which case the seed row is used for this read but not stored.
 */
async function seedIfOwn(ctx: PluginContext, companyId: string, schema: PreferencesSchema, raw: Record<string, unknown>): Promise<Row | null> {
  try {
    if (!schema.isOwnCompany || !(await schema.isOwnCompany(ctx, companyId, raw))) return null;
    const existing = await getRow(ctx, companyId);
    if (existing) return existing;
    const values = { ...schema.ownCompanyPins, ...legacyValues(schema, raw) };
    if (Object.keys(values).length === 0) return null;
    const row: Row = { values, updatedBy: "seed", updatedAt: new Date().toISOString() };
    const again = await getRow(ctx, companyId);
    if (again) return again;
    try {
      await ctx.state.set(scope(companyId), row);
    } catch (error) {
      ctx.logger.info("Could not store the company preferences seed", { error: error instanceof Error ? error.message : String(error) });
    }
    return row;
  } catch (error) {
    ctx.logger.info("Could not seed company preferences", { error: error instanceof Error ? error.message : String(error) });
    return null;
  }
}

/** Effective values: row, else saved legacy value, else default. No role check, no `members.list`. */
export async function readPreferences(ctx: PluginContext, companyId: string, schema: PreferencesSchema): Promise<PreferenceValues> {
  if (typeof companyId !== "string" || !companyId.trim()) throw new Error("companyId is required");
  const raw = await rawConfig(ctx, companyId);
  let row: Row | null = null;
  try {
    row = (await getRow(ctx, companyId)) ?? (await seedIfOwn(ctx, companyId, schema, raw));
  } catch {
    row = null;
  }
  return effective(ctx, companyId, schema, row, raw);
}

export type PreferencesActionContext = {
  companyId?: string | null;
  actor?: { type?: string | null; userId?: string | null } | null;
};
export type SavePreferencesResult =
  | { ok: true; values: PreferenceValues; previous: PreferenceValues }
  | { ok: false; error: string };

const refuse = (error: string): SavePreferencesResult => ({ ok: false, error });

/** Fails closed: a role that cannot be verified is a refusal, and nothing is written. */
export async function savePreferences(
  ctx: PluginContext,
  action: PreferencesActionContext,
  schema: PreferencesSchema,
  patch: Record<string, PreferenceValue | null>,
): Promise<SavePreferencesResult> {
  const companyId = typeof action.companyId === "string" ? action.companyId.trim() : "";
  if (!companyId) return refuse("A company is required");
  const userId = action.actor?.type === "user" && typeof action.actor.userId === "string" ? action.actor.userId.trim() : "";
  if (!userId) return refuse("Only a signed-in company owner or admin can change preferences");

  // Same rule as the CRM's viewerFor: local-board is the owner of a local instance.
  if (userId !== LOCAL_BOARD_USER_ID) {
    let role: string | null | undefined;
    try {
      const members = await ctx.access.members.list({ companyId });
      role = members.find((m) => m.principalType === "user" && m.principalId === userId && m.status === "active")?.membershipRole;
    } catch {
      return refuse("Cannot verify your role");
    }
    if (role !== "owner" && role !== "admin") return refuse("Only a company owner or admin can change preferences");
  }

  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return refuse("Nothing to save");
  const set: PreferenceValues = {};
  const clear: string[] = [];
  for (const [id, value] of Object.entries(patch)) {
    const field = Object.hasOwn(schema.fields, id) ? schema.fields[id] : undefined;
    if (!field) return refuse(`Unknown preference "${id}"`);
    if (value === null) {
      clear.push(id);
      continue;
    }
    const problem = checkValue(field, value);
    if (problem) return refuse(`${field.label} ${problem}`);
    set[id] = value;
  }

  const raw = await rawConfig(ctx, companyId);
  let seeded: Row | null = null;
  if (!(await getRow(ctx, companyId))) seeded = await seedIfOwn(ctx, companyId, schema, raw);
  // Fresh read right before the write, so a seed that landed meanwhile is merged, not overwritten.
  const current = (await getRow(ctx, companyId)) ?? seeded;
  const previous = await effective(ctx, companyId, schema, current, raw);
  const values = { ...(current?.values ?? {}), ...set };
  for (const id of clear) delete values[id];
  // Drop keys not in the schema so stale keys do not count toward the 16 KB cap.
  const filtered: PreferenceValues = {};
  for (const [key, value] of Object.entries(values)) {
    if (Object.hasOwn(schema.fields, key)) filtered[key] = value;
  }
  const row: Row = { values: filtered, updatedBy: userId, updatedAt: new Date().toISOString() };
  if (Buffer.byteLength(JSON.stringify(row), "utf8") > PREFERENCES_MAX_BYTES) {
    return refuse(`Preferences are too large (limit ${PREFERENCES_MAX_BYTES} bytes)`);
  }
  try {
    await ctx.state.set(scope(companyId), row);
  } catch (error) {
    ctx.logger.info("Could not save preferences", { error: error instanceof Error ? error.message : String(error) });
    return refuse("Could not save preferences");
  }
  return { ok: true, values: await effective(ctx, companyId, schema, row, raw), previous };
}

export type PreferenceDescriptor = {
  id: string;
  type: PreferenceField["type"];
  label: string;
  help?: string;
  /** Absent when the default is computed per company. */
  default?: PreferenceValue;
  min?: number;
  max?: number;
  options?: readonly string[];
};

/** Serializable field list for the settings panel. */
export function describePreferences(schema: PreferencesSchema): PreferenceDescriptor[] {
  return Object.entries(schema.fields).map(([id, field]) => {
    const out: PreferenceDescriptor = { id, type: field.type, label: field.label };
    if (field.help) out.help = field.help;
    if (typeof field.default !== "function") out.default = field.default;
    if (field.type === "string" || field.type === "text") out.max = field.max ?? DEFAULT_MAX[field.type];
    if (field.type === "int") {
      if (field.min !== undefined) out.min = field.min;
      if (field.max !== undefined) out.max = field.max;
    }
    if (field.type === "enum") out.options = field.options;
    return out;
  });
}
