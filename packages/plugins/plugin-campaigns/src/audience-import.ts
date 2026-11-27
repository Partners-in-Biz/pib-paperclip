/**
 * Adding people to a campaign (rework plan PAR-9192 rev 2, 5.5; Stage 4c): import a CSV, add one, tick own contacts.
 *
 * - Preview first: every row is `new`, `duplicate`, `suppressed` (on this sender's do-not-contact list) or `invalid`,
 *   and `noOptIn` counts the rows going in whose mobile has no SMS or WhatsApp opt-in for this sender.
 * - A client campaign: the people go into that client's list (`audience_members`), never into our CRM contacts.
 * - Our own campaign: Campaigns may not write the CRM, so the result carries the CRM's own import (`crm.import-contacts`,
 *   the same import the CRM's `import-contacts` tool runs) with the campaign's tag; the page sends it to the CRM, so the
 *   CRM stays the one list of our contacts. A person already in the CRM is a duplicate and gets the tag that way.
 * - The person states the source and the lawful basis; both go on every row. Suppressed people are not added.
 * - People without an opt-in are added and marked: `reach.sms` / `reach.whatsapp` false ("cannot receive SMS/WhatsApp").
 * - Adding people is never a send: nothing here enrolls, launches or opens a step.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { senderKeyOf, textArrayParam } from "@partnersinbiz/pib-plugin-kit";
import { normalizePhone } from "./channels.js";
import { addAudienceMember, blockedAddresses, consentedAddresses, LAWFUL_BASES, listAudienceMembers, suppressedEmails, table, type LawfulBasisValue } from "./db.js";
import { CampaignError, type CampaignDraft } from "./domain.js";

const EMAIL = /^[^\s@<>(),;:"[\]\\]+@[^\s@<>(),;:"[\]\\]+\.[^\s@<>(),;:"[\]\\]+$/;
export const MAX_IMPORT_ROWS = 5000;
export const CRM_PLUGIN = "partnersinbiz.crm";

export type ImportStatus = "new" | "duplicate" | "suppressed" | "invalid";
export interface ImportCandidate { line: number; name: string | null; email: string | null; phone: string | null }
export interface Reach { email: boolean; sms: boolean; whatsapp: boolean }
export interface ImportRow extends ImportCandidate { status: ImportStatus; reason?: string; reach: Reach }
export interface ImportCounts { total: number; new: number; duplicate: number; suppressed: number; invalid: number; noOptIn: number }
export interface ColumnMap { name?: string | null; email?: string | null; phone?: string | null }

/** RFC 4180 CSV: quoted cells, doubled quotes, CRLF or LF. Blank lines are dropped. */
export function parseCsv(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  const end = () => {
    row.push(cell);
    cell = "";
    if (row.some((value) => value.trim() !== "")) rows.push(row);
    row = [];
  };
  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (quoted) {
      if (char === '"' && input[i + 1] === '"') { cell += '"'; i++; } else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") { row.push(cell); cell = ""; } else if (char === "\n" || char === "\r") {
      if (char === "\r" && input[i + 1] === "\n") i++;
      end();
    } else cell += char;
  }
  if (cell !== "" || row.length) end();
  return rows;
}

const GUESS: Record<keyof ColumnMap, string[]> = {
  name: ["name", "full name", "fullname", "contact", "first name"],
  email: ["email", "emails", "e-mail", "email address"],
  phone: ["phone", "phones", "mobile", "cell", "cellphone", "mobile number", "phone number", "whatsapp"],
};

/** Header columns from the person's map, or guessed from the header names. */
export function mapColumns(headers: string[], map: ColumnMap = {}): Record<keyof ColumnMap, number> {
  const lower = headers.map((header) => header.trim().toLowerCase());
  const pick = (key: keyof ColumnMap): number => {
    const chosen = map[key]?.trim().toLowerCase();
    if (chosen) {
      const at = lower.indexOf(chosen);
      if (at < 0) throw new CampaignError(`The file has no column "${map[key]}"`);
      return at;
    }
    return lower.findIndex((header) => GUESS[key].includes(header));
  };
  const out = { name: pick("name"), email: pick("email"), phone: pick("phone") };
  if (out.email < 0 && out.phone < 0) throw new CampaignError("Map an email or a mobile column");
  return out;
}

/** The people in a CSV text, cleaned: email lower-cased, mobile in international form. */
export function readCsvPeople(csv: string, map: ColumnMap = {}): { headers: string[]; people: ImportCandidate[] } {
  const parsed = parseCsv(csv);
  if (parsed.length < 2) throw new CampaignError("The file needs a header row and at least one person");
  if (parsed.length - 1 > MAX_IMPORT_ROWS) throw new CampaignError(`At most ${MAX_IMPORT_ROWS} people per file`);
  const headers = parsed[0].map((header) => header.trim());
  const col = mapColumns(headers, map);
  const at = (row: string[], i: number) => (i >= 0 ? (row[i] ?? "").trim() : "");
  const people = parsed.slice(1).map((row, i) => person(i + 2, at(row, col.name), at(row, col.email), at(row, col.phone)));
  return { headers, people };
}

/** One person typed in ("Add one"), cleaned as an imported row. */
export function person(line: number, name: unknown, email: unknown, phone: unknown): ImportCandidate & { rawEmail: string; rawPhone: string } {
  const rawEmail = typeof email === "string" ? email.trim() : "";
  const rawPhone = typeof phone === "string" ? phone.trim() : "";
  return {
    line,
    name: typeof name === "string" && name.trim() ? name.trim().slice(0, 200) : null,
    email: EMAIL.test(rawEmail) ? rawEmail.toLowerCase() : null,
    phone: rawPhone ? normalizePhone(rawPhone) : null,
    rawEmail,
    rawPhone,
  };
}

/** What the database says about these people for this campaign's sender. */
export interface ImportFacts {
  /** Emails and mobiles already there: our CRM contacts (own) or this client's list (client). */
  existing: Set<string>;
  suppressedEmails: Set<string>;
  blocked: { sms: Set<string>; whatsapp: Set<string> };
  optedIn: { sms: Set<string>; whatsapp: Set<string> };
  /** Own campaigns go through the CRM import, which needs a name. */
  needsName: boolean;
}

/** Sorts each row and counts the preview. Pure: the same fixture always gives the same counts. */
export function classify(people: Array<ImportCandidate & { rawEmail?: string; rawPhone?: string }>, facts: ImportFacts): { rows: ImportRow[]; counts: ImportCounts } {
  const seen = new Set<string>();
  const rows = people.map((p): ImportRow => {
    const sms = !!p.phone && facts.optedIn.sms.has(p.phone) && !facts.blocked.sms.has(p.phone);
    const whatsapp = !!p.phone && facts.optedIn.whatsapp.has(p.phone) && !facts.blocked.whatsapp.has(p.phone);
    const reach: Reach = { email: !!p.email, sms, whatsapp };
    const row = { line: p.line, name: p.name, email: p.email, phone: p.phone, reach };
    if (p.rawEmail && !p.email) return { ...row, status: "invalid", reason: "not an email address" };
    if (p.rawPhone && !p.phone) return { ...row, status: "invalid", reason: "not a phone number" };
    if (!p.email && !p.phone) return { ...row, status: "invalid", reason: "no email or mobile" };
    if (facts.needsName && !p.name) return { ...row, status: "invalid", reason: "no name" };
    const textBlocked = !!p.phone && facts.blocked.sms.has(p.phone) && facts.blocked.whatsapp.has(p.phone);
    if ((p.email && facts.suppressedEmails.has(p.email)) || (!p.email && textBlocked)) return { ...row, status: "suppressed", reason: "on the do-not-contact list for this sender" };
    const keys = [p.email, p.phone].filter((key): key is string => !!key);
    if (keys.some((key) => seen.has(key))) return { ...row, status: "duplicate", reason: "twice in this file" };
    for (const key of keys) seen.add(key);
    if (keys.some((key) => facts.existing.has(key))) return { ...row, status: "duplicate", reason: facts.needsName ? "already a CRM contact: gets the tag" : "already on this list" };
    return { ...row, status: "new" };
  });
  const counts: ImportCounts = { total: rows.length, new: 0, duplicate: 0, suppressed: 0, invalid: 0, noOptIn: 0 };
  for (const row of rows) {
    counts[row.status] += 1;
    if (goesIn(row, facts.needsName) && row.phone && !row.reach.sms && !row.reach.whatsapp) counts.noOptIn += 1;
  }
  return { rows, counts };
}

/** New people go in; for our own campaign a CRM contact found again goes in too (the CRM import tags it). */
function goesIn(row: ImportRow, own: boolean): boolean {
  return row.status === "new" || (own && row.status === "duplicate" && row.reason !== "twice in this file");
}

type Target = { own: true; tag: string; senderKey: string } | { own: false; client: { kind: "company" | "contact"; id: string }; listName: string; senderKey: string };

/** Where a campaign's added people go. Refuses a campaign that cannot take them. */
export function importTarget(campaign: CampaignDraft, listName?: unknown): Target {
  if (campaign.status === "completed") throw new CampaignError("This campaign is completed; people can no longer be added");
  const senderKey = senderKeyOf(campaign);
  if (!campaign.clientRef) {
    const tag = campaign.audienceTags[0];
    if (!tag) throw new CampaignError("Give the campaign an audience tag first: people you add get that tag in the CRM");
    return { own: true, tag, senderKey };
  }
  if (campaign.audienceMode !== "client_list") throw new CampaignError("Set the audience to the client's own list (client_list) first: a client's people never join our CRM contacts");
  const name = typeof listName === "string" && listName.trim() ? listName.trim() : campaign.name;
  return { own: false, client: { kind: campaign.clientKind ?? "company", id: campaign.clientRef }, listName: name.slice(0, 200), senderKey };
}

async function loadFacts(ctx: PluginContext, companyId: string, target: Target, people: ImportCandidate[]): Promise<ImportFacts> {
  const emails = [...new Set(people.map((p) => p.email).filter((v): v is string => !!v))];
  const phones = [...new Set(people.map((p) => p.phone).filter((v): v is string => !!v))];
  const existing = new Set<string>();
  if (target.own) {
    const rows = await ctx.db.query<{ emails: string[]; phones: string[] }>(
      `SELECT emails, phones FROM ${table(ctx, "crm_contacts")}
        WHERE company_id = $1 AND deleted = false AND (emails && ${textArrayParam(2)} OR cardinality(phones) > 0)`,
      [companyId, JSON.stringify(emails)],
    );
    for (const row of rows) {
      for (const email of row.emails ?? []) existing.add(email.trim().toLowerCase());
      for (const phone of row.phones ?? []) { const e164 = normalizePhone(phone); if (e164) existing.add(e164); }
    }
  } else {
    for (const m of await listAudienceMembers(ctx, companyId, target.client, target.listName, 5000)) {
      if (m.email) existing.add(m.email);
      if (m.phone) existing.add(m.phone);
    }
  }
  const [suppressed, smsBlocked, waBlocked, smsIn, waIn] = await Promise.all([
    suppressedEmails(ctx, companyId, emails, target.senderKey),
    blockedAddresses(ctx, companyId, "sms", phones, target.senderKey),
    blockedAddresses(ctx, companyId, "whatsapp", phones, target.senderKey),
    consentedAddresses(ctx, companyId, "sms", phones, target.senderKey),
    consentedAddresses(ctx, companyId, "whatsapp", phones, target.senderKey),
  ]);
  return { existing, suppressedEmails: suppressed, blocked: { sms: smsBlocked, whatsapp: waBlocked }, optedIn: { sms: smsIn, whatsapp: waIn }, needsName: target.own };
}

/** The preview: counts and the first rows, nothing written. */
export async function previewImport(ctx: PluginContext, companyId: string, campaign: CampaignDraft, people: ImportCandidate[], listName?: unknown) {
  const target = importTarget(campaign, listName);
  const { rows, counts } = classify(people, await loadFacts(ctx, companyId, target, people));
  return { counts, rows: rows.slice(0, 200), target: target.own ? { kind: "crm", tag: target.tag } : { kind: "list", client: target.client, listName: target.listName } };
}

export interface Provenance { source: string; lawfulBasis: LawfulBasisValue; addedBy: string | null }

/** The source and lawful basis the person stated. Both are required. */
export function readProvenance(params: Record<string, unknown>, addedBy: string | null): Provenance {
  const source = typeof params.source === "string" ? params.source.trim().slice(0, 200) : "";
  if (!source) throw new CampaignError("Say where these people came from (source)");
  const basis = params.lawfulBasis;
  if (typeof basis !== "string" || !(LAWFUL_BASES as readonly string[]).includes(basis)) throw new CampaignError(`lawfulBasis must be one of ${LAWFUL_BASES.join(", ")}`);
  return { source, lawfulBasis: basis as LawfulBasisValue, addedBy };
}

function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** Confirms an import (or one added person): writes the client's list, or returns the CRM import for our own campaign. */
export async function applyImport(ctx: PluginContext, companyId: string, campaign: CampaignDraft, people: ImportCandidate[], provenance: Provenance, listName?: unknown) {
  const target = importTarget(campaign, listName);
  const { rows, counts } = classify(people, await loadFacts(ctx, companyId, target, people));
  const going = rows.filter((row) => goesIn(row, target.own));
  const cannotText = going.filter((row) => !row.reach.sms && !row.reach.whatsapp).length;
  if (target.own) {
    // The CRM's import format (plugin-crm `import-contacts`): name, emails, phones, tags; source and lawful basis ride along.
    const lines = ["name,emails,phones,tags,source,lawful_basis", ...going.map((row) => [row.name ?? "", row.email ?? "", row.phone ?? "", target.tag, provenance.source, provenance.lawfulBasis].map(csvCell).join(","))];
    return {
      counts, added: 0, cannotText, rows: rows.slice(0, 200),
      crm: going.length ? { plugin: CRM_PLUGIN, action: "crm.import-contacts", params: { csv: lines.join("\n") } } : null,
    };
  }
  let added = 0;
  for (const row of going) {
    // ON CONFLICT DO NOTHING: a row a parallel import just added is not counted twice.
    if (await addAudienceMember(ctx, { companyId, client: target.client, listName: target.listName, name: row.name, email: row.email, phone: row.phone, ...provenance })) added += 1;
  }
  return { counts, added, cannotText, rows: rows.slice(0, 200), crm: null, listName: target.listName };
}

/** Ticking our own CRM contacts: they get the campaign's tag through the CRM's bulk tag. Unknown ids are refused. */
export async function tickContacts(ctx: PluginContext, companyId: string, campaign: CampaignDraft, contactIds: string[]) {
  const target = importTarget(campaign);
  if (!target.own) throw new CampaignError("Ticking CRM contacts is for our own campaigns; a client's people go on the client's list");
  const wanted = [...new Set(contactIds.filter((id) => typeof id === "string" && id.trim()))];
  if (wanted.length === 0) throw new CampaignError("Tick at least one contact");
  if (wanted.length > MAX_IMPORT_ROWS) throw new CampaignError(`At most ${MAX_IMPORT_ROWS} contacts at once`);
  const found = await ctx.db.query<{ id: string }>(
    `SELECT id FROM ${table(ctx, "crm_contacts")} WHERE company_id = $1 AND deleted = false AND id = ANY(${textArrayParam(2)})`,
    [companyId, JSON.stringify(wanted)],
  );
  const known = new Set(found.map((row) => row.id));
  const missing = wanted.filter((id) => !known.has(id));
  if (missing.length) throw new CampaignError(`Not a contact in this workspace: ${missing.slice(0, 5).join(", ")}`);
  return { tag: target.tag, count: wanted.length, crm: { plugin: CRM_PLUGIN, action: "crm.bulk-tag-contacts", params: { contactIds: wanted, tags: [target.tag], action: "add" } } };
}

/** A client list as the approver sees it, each person marked with what can reach them for this sender. */
export async function listMembersWithReach(ctx: PluginContext, companyId: string, campaign: CampaignDraft, listName?: unknown) {
  const target = importTarget(campaign, listName);
  if (target.own) throw new CampaignError("Our own campaign's people are CRM contacts with its tag");
  const members = await listAudienceMembers(ctx, companyId, target.client, typeof listName === "string" && listName.trim() ? target.listName : null, 5000);
  const phones = members.map((m) => m.phone).filter((v): v is string => !!v);
  const [smsIn, waIn, smsBlocked, waBlocked] = await Promise.all([
    consentedAddresses(ctx, companyId, "sms", phones, target.senderKey),
    consentedAddresses(ctx, companyId, "whatsapp", phones, target.senderKey),
    blockedAddresses(ctx, companyId, "sms", phones, target.senderKey),
    blockedAddresses(ctx, companyId, "whatsapp", phones, target.senderKey),
  ]);
  return {
    members: members.map((m) => ({
      ...m,
      reach: { email: !!m.email, sms: !!m.phone && smsIn.has(m.phone) && !smsBlocked.has(m.phone), whatsapp: !!m.phone && waIn.has(m.phone) && !waBlocked.has(m.phone) },
    })),
  };
}
