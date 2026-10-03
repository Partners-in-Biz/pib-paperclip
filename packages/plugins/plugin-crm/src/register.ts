/**
 * The data-processing register and the client sensitivity flag (audit Q10-13,
 * the critic's "no data-processing map").
 *
 * The register is a table seeded from `docs/data-processing-register.md` (embedded
 * in the worker at build time, see scripts/register-doc.mjs): every system that holds
 * personal data for us, what it gets, where it sits, how long it keeps it and whether
 * an agreement is on file. It is read-only: no tool or page edits a row; a change is a
 * change to the docs file, which is shipped and re-seeded.
 *
 * A client can be flagged `sensitive`. The flag does not itself reroute anything; it is
 * the fact the Cockpit and Jev routing read later: a sensitive client's data must stay
 * off every system the register does not mark `cleared`. It is stored per client,
 * returned by `get-client-profile` and announced as `client.sensitivity` (a hand-off,
 * re-sent hourly for a day and again every night for every sensitive client). An agent
 * may raise a client to sensitive; only a person lowers it.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { getSensitivity, listSensitivity, saveSensitivity, type ClientKey, type SensitivityLevel, SENSITIVITY_LEVELS } from "./care-store.js";
import { asStringList, table } from "./db.js";
import { CrmError, type Viewer } from "./domain.js";
import { sendHandoff } from "./handoffs.js";
import { parseClientRef, requireClient } from "./lookup.js";
import { refOf } from "./refs.js";
import { REGISTER_DOC } from "./register-doc.generated.js";

/** The hand-off the Cockpit and Jev routing read. */
export const CLIENT_SENSITIVITY_EVENT = "client.sensitivity";

export type SensitiveRule = "cleared" | "not cleared" | "conditional";

export interface RegisterRow {
  id: string;
  name: string;
  role: string;
  purpose: string;
  dataClasses: string[];
  region: string;
  retention: string;
  agreement: string;
  safeguards: string;
  sensitiveClients: string;
  ownerAction: string | null;
}

export interface RegisterDoc {
  version: string;
  rows: RegisterRow[];
}

const COLUMNS = ["id", "name", "role", "purpose", "data", "region", "retention", "agreement", "safeguards", "sensitive clients", "owner action"] as const;

/** The table between the register markers, as rows. Throws when the file is malformed, so a bad edit fails the build's test, not production. */
export function parseRegisterDoc(markdown: string): RegisterDoc {
  const version = /^Version:\s*(\S+)\s*$/m.exec(markdown)?.[1];
  if (!version) throw new Error("The register file has no Version: line");
  const body = /<!-- register:start -->([\s\S]*?)<!-- register:end -->/.exec(markdown)?.[1];
  if (!body) throw new Error("The register file has no register:start and register:end markers");
  const lines = body.split("\n").map((line) => line.trim()).filter((line) => line.startsWith("|"));
  if (lines.length < 3) throw new Error("The register table has no rows");
  const cells = (line: string) => line.replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
  const header = cells(lines[0]!);
  if (COLUMNS.some((name, index) => header[index] !== name) || header.length !== COLUMNS.length) throw new Error(`The register header must be: ${COLUMNS.join(" | ")}`);
  const rows: RegisterRow[] = [];
  for (const line of lines.slice(2)) {
    const c = cells(line);
    if (c.length !== COLUMNS.length) throw new Error(`Register row has ${c.length} columns, expected ${COLUMNS.length}: ${line.slice(0, 60)}`);
    const id = c[0]!;
    if (!/^[a-z0-9-]{2,40}$/.test(id)) throw new Error(`Register id "${id}" must be lower-case letters, digits and dashes`);
    if (rows.some((row) => row.id === id)) throw new Error(`Register id "${id}" appears twice`);
    if (c.slice(1, 10).some((cell) => !cell)) throw new Error(`Register row ${id} has an empty cell`);
    const row: RegisterRow = { id, name: c[1]!, role: c[2]!, purpose: c[3]!, dataClasses: c[4]!.split(",").map((item) => item.trim()).filter(Boolean), region: c[5]!, retention: c[6]!, agreement: c[7]!, safeguards: c[8]!, sensitiveClients: c[9]!, ownerAction: c[10] || null };
    if (!ruleOf(row)) throw new Error(`Register row ${id}: "sensitive clients" must start with cleared, not cleared or conditional`);
    rows.push(row);
  }
  return { version, rows };
}

export function ruleOf(row: Pick<RegisterRow, "sensitiveClients">): SensitiveRule | null {
  const text = row.sensitiveClients.trim().toLowerCase();
  if (text.startsWith("not cleared")) return "not cleared";
  if (text.startsWith("cleared")) return "cleared";
  if (text.startsWith("conditional")) return "conditional";
  return null;
}

export const REGISTER: RegisterDoc = parseRegisterDoc(REGISTER_DOC);

/** The systems a client flagged sensitive must stay off: everything the register does not mark `cleared`. */
export function systemsNotCleared(rows: readonly RegisterRow[] = REGISTER.rows): string[] {
  return rows.filter((row) => ruleOf(row) !== "cleared").map((row) => row.name);
}

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

interface RegisterDbRow {
  system_id: string;
  name: string;
  role: string;
  purpose: string;
  data_classes: unknown;
  region: string;
  retention: string;
  agreement: string;
  safeguards: string;
  sensitive_clients: string;
  owner_action: string | null;
  doc_version: string;
}

const COLUMNS_SQL = "system_id, name, role, purpose, data_classes, region, retention, agreement, safeguards, sensitive_clients, owner_action, doc_version";

function mapRow(row: RegisterDbRow): RegisterRow & { docVersion: string } {
  return { id: row.system_id, name: row.name, role: row.role, purpose: row.purpose, dataClasses: asStringList(row.data_classes), region: row.region, retention: row.retention, agreement: row.agreement, safeguards: row.safeguards, sensitiveClients: row.sensitive_clients, ownerAction: row.owner_action ?? null, docVersion: row.doc_version };
}

export async function listRegister(ctx: PluginContext, companyId: string): Promise<Array<RegisterRow & { docVersion: string }>> {
  const rows = await ctx.db.query<RegisterDbRow>(`SELECT ${COLUMNS_SQL} FROM ${table(ctx, "processing_register")} WHERE company_id = $1 ORDER BY system_id LIMIT 200`, [companyId]);
  return rows.map(mapRow);
}

/**
 * Makes the company's register match the docs file: rows are added, changed (when the file's version differs) and removed. Safe to run
 * as often as you like. Returns how many rows it wrote.
 */
export async function seedRegister(ctx: PluginContext, companyId: string, doc: RegisterDoc = REGISTER): Promise<number> {
  const have = new Map((await listRegister(ctx, companyId)).map((row) => [row.id, row]));
  let written = 0;
  for (const row of doc.rows) {
    const current = have.get(row.id);
    if (current && current.docVersion === doc.version && current.sensitiveClients === row.sensitiveClients && current.region === row.region) continue;
    await ctx.db.execute(
      `INSERT INTO ${table(ctx, "processing_register")} (company_id, system_id, name, role, purpose, data_classes, region, retention, agreement, safeguards, sensitive_clients, owner_action, doc_version, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11, $12, $13, now())
       ON CONFLICT (company_id, system_id) DO UPDATE SET
         name = EXCLUDED.name, role = EXCLUDED.role, purpose = EXCLUDED.purpose, data_classes = EXCLUDED.data_classes, region = EXCLUDED.region, retention = EXCLUDED.retention,
         agreement = EXCLUDED.agreement, safeguards = EXCLUDED.safeguards, sensitive_clients = EXCLUDED.sensitive_clients, owner_action = EXCLUDED.owner_action,
         doc_version = EXCLUDED.doc_version, updated_at = EXCLUDED.updated_at`,
      [companyId, row.id, row.name, row.role, row.purpose, JSON.stringify(row.dataClasses), row.region, row.retention, row.agreement, row.safeguards, row.sensitiveClients, row.ownerAction, doc.version],
    );
    written += 1;
  }
  const wanted = new Set(doc.rows.map((row) => row.id));
  for (const id of have.keys()) {
    if (wanted.has(id)) continue;
    await ctx.db.execute(`DELETE FROM ${table(ctx, "processing_register")} WHERE company_id = $1 AND system_id = $2`, [companyId, id]);
    written += 1;
  }
  return written;
}

/** `list-data-processing`: the register, optionally only what a sensitive client must avoid. */
export async function listDataProcessingTool(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>) {
  await seedRegister(ctx, viewer.companyId).catch(() => 0);
  const rows = await listRegister(ctx, viewer.companyId);
  const filtered = params.forSensitiveClient === true ? rows.filter((row) => ruleOf(row) !== "cleared") : rows;
  const open = rows.filter((row) => /^unverified/i.test(row.agreement)).length;
  return {
    version: REGISTER.version,
    count: filtered.length,
    agreementsUnverified: open,
    systems: filtered.map((row) => ({ id: row.id, name: row.name, role: row.role, purpose: row.purpose, data: row.dataClasses, region: row.region, retention: row.retention, agreement: row.agreement, safeguards: row.safeguards, sensitiveClients: row.sensitiveClients, ownerAction: row.ownerAction })),
    note: "Read-only. A client flagged sensitive (set-client-sensitivity) must stay off every system that is not cleared. `unverified` is a to-do for the owner, not a yes.",
  };
}

// ---------------------------------------------------------------------------
// Client sensitivity
// ---------------------------------------------------------------------------

export interface SensitivityView {
  level: SensitivityLevel;
  reason: string | null;
  updatedAt: string | null;
  /** The systems this client's data must stay off (empty for a standard client). */
  keepOffSystems: string[];
}

export async function sensitivityOf(ctx: PluginContext, companyId: string, client: ClientKey): Promise<SensitivityView> {
  const record = await getSensitivity(ctx, companyId, client).catch(() => null);
  const level = record?.level ?? "standard";
  return { level, reason: record?.reason ?? null, updatedAt: record?.updatedAt ?? null, keepOffSystems: level === "sensitive" ? systemsNotCleared() : [] };
}

async function announce(ctx: PluginContext, companyId: string, client: ClientKey, level: SensitivityLevel, reason: string | null, updatedAt: string): Promise<void> {
  await sendHandoff(ctx, companyId, CLIENT_SENSITIVITY_EVENT, {
    key: `sensitivity:${client.kind}:${client.id}:${updatedAt}`,
    clientKind: client.kind,
    clientRef: client.id,
    level,
    reason,
    keepOffSystems: level === "sensitive" ? systemsNotCleared() : [],
    updatedAt,
  }).catch(() => false);
}

/** `set-client-sensitivity`: an agent may raise it, only a person lowers it. */
export async function setClientSensitivityTool(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>, source: "agent" | "human") {
  const client = parseClientRef(params.client);
  const name = await requireClient(ctx, viewer, client);
  const level = typeof params.level === "string" ? params.level : "";
  if (!(SENSITIVITY_LEVELS as readonly string[]).includes(level)) throw new CrmError("level must be standard or sensitive");
  const reason = typeof params.reason === "string" ? params.reason.trim().slice(0, 500) : "";
  const current = await sensitivityOf(ctx, viewer.companyId, client);
  if (level === "standard" && current.level === "sensitive" && source !== "human") throw new CrmError("Only a person can lower a client from sensitive to standard. Put a Needs-you item on the client with the reason.");
  if (level === "sensitive" && reason.length < 10) throw new CrmError("Say why this client's data is sensitive (at least a sentence) in `reason`: health, legal, financial or children's data, or a contract that limits where data goes.");
  if (level === current.level && (reason || null) === (current.reason ?? null)) return { client: refOf(client.kind, client.id), name, level, unchanged: true };
  await saveSensitivity(ctx, viewer.companyId, { client, level: level as SensitivityLevel, reason: reason || null, setBy: viewer.agentId ? `agent:${viewer.agentId}` : viewer.userId ? `user:${viewer.userId}` : null });
  const at = new Date().toISOString();
  await announce(ctx, viewer.companyId, client, level as SensitivityLevel, reason || null, at);
  return {
    client: refOf(client.kind, client.id),
    name,
    level,
    reason: reason || null,
    keepOffSystems: level === "sensitive" ? systemsNotCleared() : [],
    next: level === "sensitive" ? "From now on handle this client's data only on systems the register marks cleared (list-data-processing with forSensitiveClient true shows what to avoid): no Hermes or other outside model agents, no TypeSafe, no Resend." : "The client is back to standard handling.",
  };
}

/** Nightly: say again which clients are sensitive (the Cockpit and routing may have been down when it was first said). */
export async function reemitSensitivity(ctx: PluginContext, companyId: string): Promise<number> {
  let sent = 0;
  for (const record of await listSensitivity(ctx, companyId)) {
    if (record.level !== "sensitive") continue;
    await ctx.events.emit(CLIENT_SENSITIVITY_EVENT, companyId, {
      key: `sensitivity:${record.client.kind}:${record.client.id}:${record.updatedAt ?? "now"}`,
      clientKind: record.client.kind,
      clientRef: record.client.id,
      level: record.level,
      reason: record.reason,
      keepOffSystems: systemsNotCleared(),
      updatedAt: record.updatedAt ?? new Date().toISOString(),
    }).catch(() => undefined);
    sent += 1;
  }
  return sent;
}
