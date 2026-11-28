/**
 * Social for a limited person (access stage B2, PAR-15210): he works only on the posts, accounts, media and inbox of
 * his own companies' clients (`own-clients.ts`). The guard hands a `linked` decision only under `enforce`, and only
 * for a key marked `scoped` in the access table; every such key has a rule here (`tests/own-scope.pg.spec.ts` holds
 * the two lists equal). A key with no rule is refused (fail closed).
 *
 * - `client`: the call names one of his clients (`client`, or `clientKind` + `clientRef`); none, `all` or own work is refused.
 * - `post` / `account` / `inbox`: the record named by id (`postId`, `accountId`, `itemId`) belongs to one of his clients;
 *   destinations, approvals and metrics hang off the post. `posts`: every id of a bulk call.
 * - `post-or-client`, `account-or-client`: the record when one is named, else the client.
 * - `load`: the page, one of his clients at a time (his first by name when none is named), without the templates and
 *   the approver candidates; `limitedTo` lists his clients. `clients`: the client list, his only.
 * - `canvas`: the card handlers filter by the viewer's clients (`canvas-cards.ts`); `client-summary`: the CRM tile, his only.
 *
 * A guessed id and another company's record get the same answer (`NOT_AMONG_YOUR_COMPANIES`). The viewer carries his
 * clients too, so `postVisible`, `accountVisible`, the inbox check and `readScope` refuse anything else behind these rules.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { NAME_YOUR_COMPANY, NOT_AMONG_YOUR_COMPANIES, type ClientScope } from "@partnersinbiz/pib-plugin-kit";
import { listClients, scopeInput } from "./clients.js";
import { getAccount, getInboxItem, getPost } from "./db.js";
import { ownsRow, ownsScope, type OwnClients } from "./own-clients.js";
import { postParams } from "./service.js";

type Rule = "load" | "clients" | "client" | "post" | "posts" | "account" | "inbox" | "post-or-client" | "account-or-client" | "canvas" | "client-summary";

const rules = (rule: Rule, keys: string[]) => keys.map((key) => [key, rule] as const);

/** Every key a limited person may reach in Social, by how its client is found. */
export const OWN_SCOPE_RULES: Readonly<Record<string, Rule>> = Object.freeze(
  Object.fromEntries([
    ...rules("load", ["social.load"]),
    ...rules("clients", ["social.clients", "tool:list-clients"]),
    ...rules("client", [
      "social.create-post",
      "social.review-outcomes",
      "social.import-media",
      "social.add-manual-account",
      "tool:create-post",
      "tool:list-posts",
      "tool:list-connected-accounts",
      "tool:list-media-assets",
      "tool:list-inbox",
      "tool:review-outcomes",
      "tool:media-compliance",
      "tool:account-analytics",
      "tool:import-media-from-url",
    ]),
    ...rules("post", [
      "social.get-post",
      "social.validate-post",
      "social.change-notes",
      "social.approval-status",
      "social.update-post",
      "social.mark-posted",
      "social.mark-destination-posted",
      "social.skip-destination",
      "social.delete-post",
      "social.attach",
      "social.detach",
      "social.review",
      "social.back-to-draft",
      "social.request-changes",
      "social.approve",
      "social.request-client-approval",
      "social.record-client-approval",
      "social.schedule",
      "social.unschedule",
      "social.retry-post",
      "tool:get-post",
      "tool:validate-post",
      "tool:get-approval-status",
      "tool:update-post",
      "tool:attach-destination",
      "tool:detach-destination",
      "tool:request-review",
      "tool:request-client-approval",
      "tool:request-creative",
      "tool:unschedule-post",
      "tool:archive-post",
      "tool:unarchive-post",
      "tool:schedule-post",
      "tool:retry-post",
      "tool:record-post-metrics",
      "tool:record-review-verdict",
      "tool:approve-post-as-delegate",
      "tool:return-post-as-delegate",
    ]),
    ...rules("posts", ["tool:bulk-schedule"]),
    ...rules("post-or-client", ["social.post-analytics", "tool:post-analytics"]),
    ...rules("account", ["social.update-account", "social.refresh-account", "social.disconnect-account", "social.delete-account", "tool:refresh-account"]),
    ...rules("account-or-client", ["tool:record-inbox-item"]),
    ...rules("inbox", [
      "social.mark-inbox-read",
      "social.mark-inbox-replied",
      "social.request-inbox-draft",
      "social.reply-inbox",
      "social.correct-triage",
      "tool:mark-inbox-read",
      "tool:reply-inbox",
    ]),
    ...rules("canvas", ["canvas.cards.resolve", "canvas.cards.search", "canvas.cards.related"]),
    ...rules("client-summary", ["api:client-summary"]),
  ]),
);

export type OwnScopeAnswer = { refused: string } | { params: Record<string, unknown>; after?: (result: unknown) => unknown };

function str(params: Record<string, unknown>, key: string): string | null {
  const v = params[key];
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/**
 * The refusal for the client a call names, or null when it is his. `required`: the call must name one. The post
 * handlers also read the old `scope` name as the client, but only when neither `client` nor `clientRef` is sent: a
 * call that names its client only that way is refused, since a handler that reads `client` alone would take it as own work.
 */
function clientRefusal(own: OwnClients, params: Record<string, unknown>, required: boolean): string | null {
  if (params.client === "all") return NAME_YOUR_COMPANY;
  let sent: ClientScope | undefined;
  let folded: ClientScope | undefined;
  try {
    sent = scopeInput(params);
    folded = scopeInput(postParams(params));
  } catch {
    return NOT_AMONG_YOUR_COMPANIES;
  }
  if (sent === undefined) return required ? NAME_YOUR_COMPANY : folded === undefined ? null : NOT_AMONG_YOUR_COMPANIES;
  return ownsScope(own, sent) ? null : NOT_AMONG_YOUR_COMPANIES;
}

/** His clients in the CRM copy, by name (the page's picker). */
async function ownClientList(ctx: PluginContext, companyId: string, own: OwnClients) {
  return (await listClients(ctx, companyId)).filter((c) => ownsScope(own, { kind: c.kind, id: c.id }));
}

/** The page of one of his clients, without what belongs to the company as a whole. */
function limitLoad(result: unknown, client: string, clients: Array<{ client: string; name: string }>): unknown {
  return { ...(result as Record<string, unknown>), templates: [], delegateCandidates: [], clients, limitedTo: { client, clients: clients.map((c) => c.client) } };
}

/**
 * Checks one call of a limited person against his clients. `key` is the guard's key (`social.<action>` or
 * `tool:<name>`). Returns the params to run with (the page may get his first client as `client`), or the refusal.
 */
export async function limitToOwnClients(ctx: PluginContext, companyId: string, own: OwnClients, key: string, params: Record<string, unknown>): Promise<OwnScopeAnswer> {
  const rule = Object.hasOwn(OWN_SCOPE_RULES, key) ? OWN_SCOPE_RULES[key] : undefined;
  // My Social (a person's own socials) has no client: closed to him.
  if (params.space !== undefined && params.space !== null && params.space !== "" && params.space !== "company") return { refused: NAME_YOUR_COMPANY };
  const ok = (refusal: string | null): OwnScopeAnswer => (refusal ? { refused: refusal } : { params });
  const byId = async (row: Parameters<typeof ownsRow>[1] | null) => ok(row && ownsRow(own, row) ? clientRefusal(own, params, false) : NOT_AMONG_YOUR_COMPANIES);
  const post = async (id: string | null) => byId(id ? await getPost(ctx, companyId, id) : null);
  const account = async (id: string | null) => byId(id ? await getAccount(ctx, companyId, id) : null);
  switch (rule) {
    case "client":
      return ok(clientRefusal(own, params, true));
    case "post":
      return post(str(params, "postId"));
    case "posts": {
      const ids = Array.isArray(params.postIds) ? params.postIds : [];
      if (!ids.length) return { refused: NOT_AMONG_YOUR_COMPANIES };
      for (const id of ids) {
        const row = typeof id === "string" && id ? await getPost(ctx, companyId, id) : null;
        if (!row || !ownsRow(own, row)) return { refused: NOT_AMONG_YOUR_COMPANIES };
      }
      return { params };
    }
    case "post-or-client":
      return params.postId !== undefined ? post(str(params, "postId")) : ok(clientRefusal(own, params, true));
    case "account":
      return account(str(params, "accountId"));
    case "account-or-client":
      return params.accountId !== undefined ? account(str(params, "accountId")) : ok(clientRefusal(own, params, true));
    case "inbox": {
      const id = str(params, "itemId");
      return byId(id ? await getInboxItem(ctx, companyId, id) : null);
    }
    case "clients": {
      const mine = await ownClientList(ctx, companyId, own);
      return { params, after: (result) => (Array.isArray(result) ? result.filter((c: { kind: "company" | "contact"; id: string }) => mine.some((m) => m.kind === c.kind && m.id === c.id)) : result) };
    }
    case "load": {
      const mine = (await ownClientList(ctx, companyId, own)).map((c) => ({ client: `${c.kind}:${c.id}`, name: c.name }));
      const named = params.client;
      let client: string | undefined;
      if (named === undefined || named === null || named === "" || named === "all") client = mine[0]?.client;
      else if (!clientRefusal(own, params, true)) client = mine.find((c) => c.client === String(named))?.client;
      if (!client) return { refused: NOT_AMONG_YOUR_COMPANIES };
      const { clientKind: _k, clientRef: _r, scope: _s, ...rest } = params;
      return { params: { ...rest, client }, after: (result) => limitLoad(result, client, mine) };
    }
    case "canvas":
      return { params };
    default:
      return { refused: NOT_AMONG_YOUR_COMPANIES };
  }
}
