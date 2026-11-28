/**
 * Campaigns for a limited person (stage B2, PAR-15209): he works only on the campaigns of his own companies (the CRM
 * companies he owns or is on "Managed by" for, read from the CRM copy). The guard hands a `linked` decision only under
 * `enforce`, and only for a key marked `scoped` in the access table; every such key has a rule here
 * (`tests/own-scope.pg.spec.ts` holds the two lists equal). A key with no rule is refused (fail closed).
 *
 * - `client`: the call names one of his clients (`client`, or `clientKind` + `clientRef`); none, `all` or `own` is refused.
 * - `load`: the page, one of his clients at a time (the one named, else his first by name); company-wide parts are left out.
 * - `summary`: the per-client counts, his clients only.
 * - `campaign` / `enrollment` / `reply`: the campaign the id leads to must be his.
 * - `person`: a person's export, only what sits on his clients' lists and senders.
 *
 * On every rule a client the call names must be his, and so must every contact it names (`contactId`, `contactIds`).
 * A campaign is his when its client is his and its audience is tied to that client: a tag audience reaches any CRM
 * contact, so such a campaign (and choosing one) stays with the owner. A guessed id and another company's record get
 * the same answer (`NOT_AMONG_YOUR_COMPANIES`).
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import {
  clientScopeFromInput,
  isOwnClient,
  NAME_YOUR_COMPANY,
  NOT_AMONG_YOUR_COMPANIES,
  parseClientParam,
  suppressionEmail,
  textArrayParam,
  type ClientScope,
} from "@partnersinbiz/pib-plugin-kit";
import { enrollmentById, getCampaign, replyEvent, table } from "./db.js";
import type { CampaignDraft } from "./domain.js";
import type { SubjectExport } from "./privacy.js";

type Rule = "client" | "load" | "summary" | "campaign" | "enrollment" | "reply" | "person";

/** A tag audience is any CRM contact with the tag, other companies' people included. */
export const TAG_AUDIENCE_CLOSED = "Your access is limited to your own companies: a campaign's audience must be its client's people, not CRM tags";
/** Stopping a person in every campaign reaches other companies' campaigns. */
export const ONE_CAMPAIGN_ONLY = "Your access is limited to your own companies: stop the person in this campaign only";

const CAMPAIGN_KEYS = [
  "campaigns.detail", "campaigns.results", "campaigns.stats", "campaigns.ab-suggestion", "campaigns.add-step",
  "campaigns.request-approval", "campaigns.pause", "campaigns.complete", "campaigns.enroll", "campaigns.declare-winner",
  "campaigns.launch", "campaigns.resume", "campaigns.approve", "campaigns.send-back", "campaigns.set-mode",
  "campaigns.audience-preview", "campaigns.audience-import", "campaigns.audience-add", "campaigns.audience-members",
  "tool:update-campaign", "tool:add-campaign-step", "tool:launch-campaign", "tool:pause-campaign", "tool:set-campaign-mode",
  "tool:resume-campaign", "tool:complete-campaign", "tool:campaign-stats", "tool:enroll-contact", "tool:preflight-campaign",
  "tool:request-campaign-approval", "tool:review-campaign-approval", "tool:create-ab-variant", "tool:campaign-funnel",
  "tool:campaign-step-analytics", "tool:campaign-results", "tool:set-step-html", "tool:edit-campaign-step",
  "tool:declare-ab-winner", "tool:suggest-ab-winner",
];

/** Every key a limited person may reach in Campaigns, by how its client is found. */
export const OWN_SCOPE_RULES: Readonly<Record<string, Rule>> = Object.freeze({
  "campaigns.load": "load",
  "campaigns.client-summary": "summary",
  "api:client-summary": "client",
  "campaigns.create-campaign": "client",
  "tool:create-campaign": "client",
  "tool:list-campaigns": "client",
  "tool:suppress-address": "client",
  "tool:suppress-phone": "client",
  "tool:record-channel-consent": "client",
  "tool:export-person-data": "person",
  "tool:stop-enrollment": "enrollment",
  "tool:record-step-event": "enrollment",
  "tool:log-reply": "reply",
  ...Object.fromEntries(CAMPAIGN_KEYS.map((key) => [key, "campaign" as const])),
});

export type OwnScopeAnswer = { refused: string } | { params: Record<string, unknown>; after?: (result: unknown) => Promise<unknown> };

const keyOf = (scope: NonNullable<ClientScope>) => `${scope.kind}:${scope.id}`;
const refuse = (refused: string): OwnScopeAnswer => ({ refused });

/** Whether a call names a client at all (the handlers read `clientScopeFromInput`, so this reads the same). */
function namesClient(params: Record<string, unknown>): boolean {
  return "client" in params || "clientRef" in params;
}

/** Whether a campaign is his: his client, and an audience tied to that client. */
async function isOwnCampaign(ctx: PluginContext, companyId: string, own: ReadonlySet<string>, campaign: CampaignDraft | null): Promise<boolean> {
  if (!campaign || campaign.companyId !== companyId || !campaign.clientRef || campaign.audienceMode === "tags") return false;
  return isOwnClient(ctx, ctx.db.namespace, companyId, own, { kind: campaign.clientKind === "contact" ? "contact" : "company", id: campaign.clientRef });
}

/** The contacts a call names that are not his (a contact missing from the CRM copy is not his). */
async function foreignContacts(ctx: PluginContext, companyId: string, own: ReadonlySet<string>, params: Record<string, unknown>): Promise<boolean> {
  const ids = new Set<string>();
  if (typeof params.contactId === "string") ids.add(params.contactId);
  if (Array.isArray(params.contactIds)) for (const id of params.contactIds) if (typeof id === "string") ids.add(id);
  if (ids.size === 0) return false;
  const rows = await ctx.db.query<{ id: string; account_ids: string[] | null }>(
    `SELECT id, account_ids FROM ${table(ctx, "crm_contacts")} WHERE company_id = $1 AND deleted = false AND id = ANY(${textArrayParam(2)})`,
    [companyId, JSON.stringify([...ids])],
  );
  const mine = new Set(rows.filter((row) => (row.account_ids ?? []).some((id) => own.has(id))).map((row) => row.id));
  return [...ids].some((id) => !mine.has(id));
}

/** His clients, by name: his companies, and the contacts of his that have campaigns here. */
export async function ownClientList(ctx: PluginContext, companyId: string, own: ReadonlySet<string>): Promise<Array<{ client: string; name: string }>> {
  const companies = await ctx.db.query<{ id: string; name: string | null }>(
    `SELECT id, name FROM ${table(ctx, "crm_companies")} WHERE company_id = $1 AND deleted = false AND id = ANY(${textArrayParam(2)})`,
    [companyId, JSON.stringify([...own])],
  );
  const contacts = await ctx.db.query<{ client_ref: string; client_name: string | null }>(
    `SELECT client_ref, max(client_name) AS client_name FROM ${table(ctx, "campaigns")}
      WHERE company_id = $1 AND client_kind = 'contact' AND client_ref IS NOT NULL GROUP BY client_ref`,
    [companyId],
  );
  const list = companies.map((row) => ({ client: `company:${row.id}`, name: row.name ?? row.id }));
  for (const row of contacts) {
    if (await isOwnClient(ctx, ctx.db.namespace, companyId, own, { kind: "contact", id: row.client_ref })) list.push({ client: `contact:${row.client_ref}`, name: row.client_name ?? row.client_ref });
  }
  return list.sort((a, b) => a.name.localeCompare(b.name) || a.client.localeCompare(b.client));
}

type Listed = { audienceMode?: string | null; id?: string };
const clientBound = <T extends Listed>(rows: T[] | undefined): T[] => (rows ?? []).filter((row) => row.audienceMode !== "tags");

/** The page for one of his clients, without the company-wide parts (other brands, the messaging setup). */
function limitLoad(result: unknown, client: string, clients: Array<{ client: string; name: string }>): unknown {
  const o = result as Record<string, unknown> & { campaigns?: Listed[]; series?: { weeks?: unknown; byCampaign?: Record<string, unknown> } };
  const campaigns = clientBound(o.campaigns);
  const ids = new Set(campaigns.map((row) => row.id));
  const byCampaign = Object.fromEntries(Object.entries(o.series?.byCampaign ?? {}).filter(([id]) => ids.has(id)));
  return { ...o, campaigns, brands: [], messaging: null, series: { ...o.series, byCampaign }, limitedTo: { client, clients } };
}

/** A person's export, only his clients' lists and senders. The addresses shown are the asked-for one and his rows'. */
async function limitExport(ctx: PluginContext, companyId: string, own: ReadonlySet<string>, params: Record<string, unknown>, result: unknown): Promise<unknown> {
  const out = result as SubjectExport & Record<string, unknown>;
  const mine = (scope: ClientScope) => (scope ? isOwnClient(ctx, ctx.db.namespace, companyId, own, scope) : Promise.resolve(false));
  const listMemberships = [];
  for (const row of out.listMemberships) if (await mine(row.client)) listMemberships.push(row);
  const consents = [];
  for (const row of out.consents) if (await mine(parseClientParam(row.senderKey))) consents.push(row);
  const seen = new Set<string>([...listMemberships.flatMap((row) => [row.email, row.phone]), ...consents.map((row) => row.address)].filter((v): v is string => Boolean(v)));
  const asked = typeof params.email === "string" && params.email.trim() ? suppressionEmail(params.email) : null;
  return {
    ...out,
    person: { emails: out.person.emails.filter((e) => e === asked || seen.has(e)), phones: out.person.phones.filter((p) => seen.has(p)) },
    listMemberships,
    consents,
    counts: { list_members: listMemberships.length, consents: consents.length },
  };
}

/**
 * Checks one call of a limited person against his companies. `key` is the guard's key (`campaigns.<action>`,
 * `tool:<name>` or `api:<route>`). Returns the params to run with (a page load may get his first client as `client`)
 * and what to do to the answer, or the refusal.
 */
export async function limitToOwnClients(ctx: PluginContext, companyId: string, own: ReadonlySet<string>, key: string, params: Record<string, unknown>): Promise<OwnScopeAnswer> {
  const rule = Object.hasOwn(OWN_SCOPE_RULES, key) ? OWN_SCOPE_RULES[key] : undefined;
  if (!rule) return refuse(NOT_AMONG_YOUR_COMPANIES);
  const scope = clientScopeFromInput(params);
  const named = namesClient(params);
  const ownScope = async () => Boolean(scope) && (await isOwnClient(ctx, ctx.db.namespace, companyId, own, scope!));
  // Checks every rule shares: the client and the contacts a call names, a tag audience, every campaign at once.
  if (params.audienceMode === "tags") return refuse(TAG_AUDIENCE_CLOSED);
  if (params.everyCampaign === true) return refuse(ONE_CAMPAIGN_ONLY);
  if (await foreignContacts(ctx, companyId, own, params)) return refuse(NOT_AMONG_YOUR_COMPANIES);
  if (rule === "load") {
    const clients = await ownClientList(ctx, companyId, own);
    const value = params.client;
    const asked = named && value !== null && value !== "" && value !== "all";
    const client = asked ? (scope && clients.some((c) => c.client === keyOf(scope)) ? keyOf(scope) : null) : clients[0]?.client ?? null;
    if (!client) return refuse(NOT_AMONG_YOUR_COMPANIES);
    const { clientKind: _k, clientRef: _r, ...rest } = params;
    return { params: { ...rest, client }, after: async (result) => limitLoad(result, client, clients) };
  }
  if (rule === "client") {
    if (!named || scope === null || params.client === "all") return refuse(NAME_YOUR_COMPANY);
    if (!(await ownScope())) return refuse(NOT_AMONG_YOUR_COMPANIES);
    if (key === "tool:list-campaigns") return { params, after: async (r) => ({ ...(r as object), campaigns: clientBound((r as { campaigns?: Listed[] }).campaigns) }) };
    return { params };
  }
  // Any other rule may still name a client (an edit moving a draft to another client): it must be his.
  if (named && !(await ownScope())) return refuse(NOT_AMONG_YOUR_COMPANIES);
  const str = (name: string) => (typeof params[name] === "string" && (params[name] as string).trim() ? (params[name] as string).trim() : null);
  const campaignOf = async (id: string | null) => (id ? getCampaign(ctx, id) : null);
  switch (rule) {
    case "summary":
      return {
        params,
        after: async (result) => {
          const rows = (result as { clients?: Array<{ kind: "company" | "contact"; id: string }> }).clients ?? [];
          const clients = [];
          for (const row of rows) if (await isOwnClient(ctx, ctx.db.namespace, companyId, own, { kind: row.kind, id: row.id })) clients.push(row);
          return { ...(result as object), clients };
        },
      };
    case "campaign":
      return (await isOwnCampaign(ctx, companyId, own, await campaignOf(str("campaignId")))) ? { params } : refuse(NOT_AMONG_YOUR_COMPANIES);
    case "enrollment": {
      const id = str("enrollmentId");
      const enrollment = id ? await enrollmentById(ctx, id) : null;
      const campaign = enrollment && enrollment.companyId === companyId ? await campaignOf(enrollment.campaignId) : null;
      return (await isOwnCampaign(ctx, companyId, own, campaign)) ? { params } : refuse(NOT_AMONG_YOUR_COMPANIES);
    }
    case "reply": {
      const id = str("messageId");
      const reply = id ? await replyEvent(ctx, companyId, id) : null;
      return (await isOwnCampaign(ctx, companyId, own, await campaignOf(reply?.campaignId ?? null))) ? { params } : refuse(NOT_AMONG_YOUR_COMPANIES);
    }
    case "person":
      return { params, after: (result) => limitExport(ctx, companyId, own, params, result) };
    default:
      return refuse(NOT_AMONG_YOUR_COMPANIES);
  }
}
