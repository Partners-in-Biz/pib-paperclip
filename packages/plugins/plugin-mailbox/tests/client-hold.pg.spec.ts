/**
 * The send guard for held drafts on a real Postgres (PAR-12249, PAR-14329): the SQL that decides whether a recipient is an
 * existing client (`SqlStore.clientRecipients`) is executed here for every rule, and the worker is driven end to end:
 * an agent's untagged draft to an existing client is refused, a plugin's draft too, and a person's send or delete tells the
 * plugin (`mail.draft.closed`). The in-memory store cannot prove any of this: it ignores lifecycle, deleted flags, billing and domains.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { MAIL_EVENTS, PIB_PLUGINS, pluginEvent } from "@partnersinbiz/pib-plugin-kit";
import { SqlStore } from "../src/db.js";
import { resetEnsureMemo } from "../src/delegations.js";
import { assertHeldDraftMaySend, replaceOlderDrafts } from "../src/draft-purpose.js";
import manifest from "../src/manifest.js";
import { NAMESPACE } from "../src/namespace.js";
import { rememberCompany } from "../src/setup-status.js";
import plugin from "../src/worker.js";
import { FakeGmail } from "./helpers/fake-gmail.js";
import { CO, ENCRYPTION_KEY } from "./helpers/memory.js";
import { embeddedAvailable, startPg, type PgHarness } from "./helpers/pg.js";
import { sealedTokens } from "./helpers/setup.js";

const available = await embeddedAvailable();
const OTHER_CO = "co-2";
const am = { agentId: "agent-am", companyId: CO };
type Result = { error?: string; data?: { id: string; status?: string; heldForPerson?: boolean; replaced?: string[] } };

describe.skipIf(!available)("held drafts and existing clients (real Postgres)", () => {
  let pg: PgHarness;

  beforeAll(async () => {
    pg = await startPg();
  }, 180_000);
  afterAll(async () => {
    vi.unstubAllGlobals();
    await pg?.stop();
  });
  beforeEach(async () => {
    await pg.reset();
    resetEnsureMemo();
  });

  const sql = async (text: string, params: unknown[] = []) => (await pg.client.query(text, params)).rows as Array<Record<string, unknown>>;
  const company = (id: string, fields: { domain?: string | null; lifecycle?: string | null; billing?: Record<string, unknown> | null; deleted?: boolean; companyId?: string }) =>
    sql(`INSERT INTO ${NAMESPACE}.crm_companies (id, company_id, name, domain, lifecycle, billing, deleted, updated_at) VALUES ($1, $2, $1, $3, $4, $5, $6, now())`, [
      id,
      fields.companyId ?? CO,
      fields.domain ?? null,
      fields.lifecycle ?? null,
      fields.billing ? JSON.stringify(fields.billing) : null,
      fields.deleted ?? false,
    ]);
  const contact = (id: string, emails: string[], fields: { lifecycle?: string | null; accountIds?: string[]; deleted?: boolean; companyId?: string } = {}) =>
    sql(`INSERT INTO ${NAMESPACE}.crm_contacts (id, company_id, name, emails, lifecycle, account_ids, deleted, updated_at) VALUES ($1, $2, $1, $3, $4, $5, $6, now())`, [
      id,
      fields.companyId ?? CO,
      emails,
      fields.lifecycle ?? null,
      fields.accountIds ?? [],
      fields.deleted ?? false,
    ]);
  /** What the guard asks: the recipients that are existing clients (free-mail domains never count by domain). */
  const clients = (emails: string[]) => {
    const store = new SqlStore(pg.db);
    const row = { draft: { holdForPerson: { reason: "held" } }, to_addrs: emails.map((email) => ({ email })), cc_addrs: [], bcc_addrs: [] };
    return assertHeldDraftMaySend(store, CO, row as never).then(
      () => [] as string[],
      (error: Error) => (/^Not sent: held (.+) (?:is|are) an existing client/.exec(error.message)?.[1] ?? error.message).split(", "),
    );
  };

  describe("SqlStore.clientRecipients: each rule, executed", () => {
    it("a contact of a customer account is a client, even when the contact itself is a lead", async () => {
      await company("acme", { domain: "acme.co.za", lifecycle: "customer" });
      await contact("ann", ["Ann@Personal.co.za"], { lifecycle: "lead", accountIds: ["acme"] });
      expect(await clients(["ann@personal.co.za"])).toEqual(["ann@personal.co.za"]);
    });

    it("a lead contact under a prospect account, or with no account, is not a client", async () => {
      await company("maybe", { domain: "maybe.co.za", lifecycle: "prospect" });
      await contact("bob", ["bob@elsewhere.co.za"], { lifecycle: "lead", accountIds: ["maybe"] });
      await contact("cat", ["cat@other.co.za"], { lifecycle: "prospect" });
      expect(await clients(["bob@elsewhere.co.za", "cat@other.co.za"])).toEqual([]);
    });

    it("a contact with no lifecycle counts as a client (unsure is a client); a deleted contact or another company's does not", async () => {
      await contact("dan", ["dan@unknown.co.za"]);
      await contact("eve", ["eve@gone.co.za"], { deleted: true });
      await contact("fay", ["fay@theirs.co.za"], { companyId: OTHER_CO, lifecycle: "customer" });
      expect(await clients(["dan@unknown.co.za", "eve@gone.co.za", "fay@theirs.co.za"])).toEqual(["dan@unknown.co.za"]);
    });

    it("a churned company or one with no lifecycle matches by domain (www and scheme stripped); a lead or prospect company does not", async () => {
      await company("old", { domain: "https://www.Churned.co.za/about", lifecycle: "churned" });
      await company("unset", { domain: "unset.co.za" });
      await company("lead", { domain: "lead.co.za", lifecycle: "lead" });
      await company("prospect", { domain: "prospect.co.za", lifecycle: "prospect" });
      expect((await clients(["a@churned.co.za", "b@unset.co.za", "c@lead.co.za", "d@prospect.co.za"])).sort()).toEqual(["a@churned.co.za", "b@unset.co.za"]);
    });

    it("a free-mail domain never matches by domain, even on a customer whose domain is set to it", async () => {
      await company("sole", { domain: "gmail.com", lifecycle: "customer" });
      expect(await clients(["stranger@gmail.com"])).toEqual([]);
    });

    it("a company's billing email matches, free-mail or not, in any case; not on a deleted or prospect company", async () => {
      await company("payer", { domain: "payer.co.za", lifecycle: "customer", billing: { email: "Accounts.Payer@gmail.com" } });
      await company("removed", { lifecycle: "customer", billing: { email: "old@removed.co.za" }, deleted: true });
      await company("pros", { lifecycle: "prospect", billing: { email: "pay@pros-billing.co.za" } });
      expect(await clients(["accounts.payer@gmail.com", "old@removed.co.za", "pay@pros-billing.co.za"])).toEqual(["accounts.payer@gmail.com"]);
    });

    it("a deleted company does not match by domain, nor another company's", async () => {
      await company("del", { domain: "deleted.co.za", lifecycle: "customer", deleted: true });
      await company("theirs", { domain: "theirs.co.za", lifecycle: "customer", companyId: OTHER_CO });
      expect(await clients(["x@deleted.co.za", "y@theirs.co.za"])).toEqual([]);
    });
  });

  describe("drafts by key, executed", () => {
    const ACCOUNT = { [CO]: "acc-1", [OTHER_CO]: "acc-2" } as Record<string, string>;
    const draftRow = (store: SqlStore, id: string, companyId: string, extras: Record<string, unknown>) =>
      store.insertDraft({ id, companyId, accountId: ACCOUNT[companyId]!, subject: id, body: "", to: [{ email: "ann@client.co.za" }], cc: [], bcc: [], draft: extras });
    async function accounts() {
      const store = new SqlStore(pg.db);
      await store.insertAccount({ id: "acc-1", companyId: CO, provider: "gmail", address: "a@co1.co.za", ownerUserId: null, isDefault: true });
      await store.insertAccount({ id: "acc-2", companyId: OTHER_CO, provider: "gmail", address: "b@co2.co.za", ownerUserId: null, isDefault: true });
      return store;
    }

    it("a replacement never reaches another company's draft with the same key, even naming its mailbox", async () => {
      const store = await accounts();
      await draftRow(store, "mine-old", CO, { purposeKey: "k" });
      await draftRow(store, "theirs", OTHER_CO, { purposeKey: "k" });
      await draftRow(store, "mine-new", CO, { purposeKey: "k" });
      expect(await replaceOlderDrafts(store, CO, "acc-2", "k", "mine-new")).toEqual([]);
      expect(await replaceOlderDrafts(store, CO, "acc-1", "k", "mine-new")).toEqual(["mine-old"]);
      expect((await sql(`SELECT id FROM ${NAMESPACE}.messages ORDER BY id`)).map((r) => r.id)).toEqual(["mine-new", "theirs"]);
    });

    it("finds a plugin's draft by its request key, in its own company only", async () => {
      const store = await accounts();
      await draftRow(store, "d1", CO, { requestKey: "seo:1" });
      expect((await store.draftByRequestKey(CO, "seo:1"))?.id).toBe("d1");
      expect(await store.draftByRequestKey(OTHER_CO, "seo:1")).toBeNull();
      expect(await store.draftByRequestKey(CO, "seo:2")).toBeNull();
    });
  });

  describe("through the worker", () => {
    async function boot() {
      const harness = createTestHarness({ manifest, config: { publicBaseUrl: "https://paperclip.example.com", encryptionKey: ENCRYPTION_KEY } });
      harness.seed({ companies: [{ id: CO, name: "Co", issuePrefix: "CO" } as never] });
      const gmail = new FakeGmail();
      vi.stubGlobal("fetch", gmail.fetch);
      (harness.ctx as unknown as { db: unknown }).db = pg.db;
      await plugin.definition.setup(harness.ctx);
      await rememberCompany(harness.ctx, CO);
      const emit = vi.spyOn(harness.ctx.events, "emit");
      const store = new SqlStore(pg.db);
      await store.insertAccount({ id: "acc-1", companyId: CO, provider: "gmail", address: gmail.email, ownerUserId: null, isDefault: true });
      await store.updateAccount(CO, "acc-1", { status: "connected", token_sealed: sealedTokens(), connected_at: new Date().toISOString() });
      // This agent may draft AND send: only the hold stands between it and the client.
      await store.grantDelegation({ id: "d1", companyId: CO, accountId: "acc-1", agentId: am.agentId, canRead: true, canDraft: true, canSend: true, source: "manual", grantedBy: null });
      const closed = () => emit.mock.calls.filter(([name]) => name === MAIL_EVENTS.draftClosed).map(([, , payload]) => payload as Record<string, unknown>);
      const status = async (id: string) => (await sql(`SELECT status FROM ${NAMESPACE}.messages WHERE id = $1`, [id]))[0]?.status;
      return { harness, gmail, store, closed, status };
    }

    it("an agent's draft with NO purpose to an existing client is held, and its send-draft is refused", async () => {
      const b = await boot();
      await company("acme", { domain: "acme.co.za", lifecycle: "customer" });
      const made = await b.harness.executeTool<Result>("create-draft", { accountId: "acc-1", subject: "Something new for you", body: "Hi", to: "ann@acme.co.za" }, am);
      expect(made.error).toBeUndefined();
      expect(made.data).toMatchObject({ heldForPerson: true });
      const sent = await b.harness.executeTool<Result>("send-draft", { messageId: made.data!.id }, am);
      expect(sent.error).toMatch(/Not sent: .*ann@acme\.co\.za is an existing client/);
      expect(await b.status(made.data!.id)).toBe("draft");
      expect(b.gmail.sent).toHaveLength(0);
    });

    it("purpose `other` is held too; a reply the client asked for is sent", async () => {
      const b = await boot();
      await company("acme", { domain: "acme.co.za", lifecycle: "customer" });
      const other = await b.harness.executeTool<Result>("create-draft", { accountId: "acc-1", subject: "FYI", body: "Hi", to: "ann@acme.co.za", purpose: "other" }, am);
      expect((await b.harness.executeTool<Result>("send-draft", { messageId: other.data!.id }, am)).error).toMatch(/existing client/);
      const reply = await b.harness.executeTool<Result>("create-draft", { accountId: "acc-1", subject: "Re: your invoice", body: "Here it is", to: "ann@acme.co.za", purpose: "reply" }, am);
      expect(reply.data?.heldForPerson).toBeUndefined();
      const sent = await b.harness.executeTool<Result>("send-draft", { messageId: reply.data!.id }, am);
      expect(sent.error).toBeUndefined();
      expect(sent.data).toMatchObject({ status: "sent" });
      expect(b.gmail.sent).toHaveLength(1);
    });

    it("an untagged draft to a prospect with no customer record goes out", async () => {
      const b = await boot();
      await company("maybe", { domain: "maybe.co.za", lifecycle: "prospect" });
      const made = await b.harness.executeTool<Result>("create-draft", { accountId: "acc-1", subject: "Hello", body: "Hi", to: "cold@maybe.co.za" }, am);
      const sent = await b.harness.executeTool<Result>("send-draft", { messageId: made.data!.id }, am);
      expect(sent.error).toBeUndefined();
      expect(b.gmail.sent).toHaveLength(1);
    });

    it("a plugin's draft to a client is refused to the agent; a person sends it and the plugin hears mail.draft.closed (sent)", async () => {
      const b = await boot();
      await company("acme", { domain: "acme.co.za", lifecycle: "customer" });
      const context = { plugin: PIB_PLUGINS.seo, kind: "seo-approval", id: "sprint-1", clientKind: "company", clientRef: "acme" };
      await b.harness.emit(pluginEvent(PIB_PLUGINS.seo, MAIL_EVENTS.draftRequested), { key: "seo-approval:sprint-1:a", to: [{ email: "ann@acme.co.za" }], subject: "Please review", text: "Links", context }, { companyId: CO });
      const [row] = await sql(`SELECT id FROM ${NAMESPACE}.messages WHERE draft ->> 'requestKey' = 'seo-approval:sprint-1:a'`);
      const id = String(row!.id);
      const refused = await b.harness.executeTool<Result>("send-draft", { messageId: id }, am);
      expect(refused.error).toMatch(/A plugin made this draft.*ann@acme\.co\.za is an existing client/);
      expect(b.closed()).toEqual([]);
      const done = await b.harness.performAction<{ status: string }>("mailbox.send-draft", { messageId: id }, { companyId: CO, actor: { type: "user", userId: "user-peet" } } as never);
      expect(done.status).toBe("sent");
      expect(b.closed()).toEqual([{ key: "seo-approval:sprint-1:a", status: "sent", mailboxDraftId: id, context: expect.objectContaining({ plugin: PIB_PLUGINS.seo, kind: "seo-approval", id: "sprint-1" }) }]);
    });

    it("a person deleting a plugin's draft tells the plugin (deleted); an agent's own draft says nothing to plugins", async () => {
      const b = await boot();
      const context = { plugin: PIB_PLUGINS.seo, kind: "seo-approval", id: "sprint-1" };
      await b.harness.emit(pluginEvent(PIB_PLUGINS.seo, MAIL_EVENTS.draftRequested), { key: "seo-approval:sprint-1:b", to: [{ email: "ann@acme.co.za" }], subject: "Please review", text: "Links", context }, { companyId: CO });
      const [row] = await sql(`SELECT id FROM ${NAMESPACE}.messages WHERE draft ->> 'requestKey' = 'seo-approval:sprint-1:b'`);
      await b.harness.performAction("mailbox.delete-draft", { messageId: String(row!.id) }, { companyId: CO, actor: { type: "user", userId: "user-peet" } } as never);
      expect(b.closed()).toEqual([expect.objectContaining({ key: "seo-approval:sprint-1:b", status: "deleted", mailboxDraftId: String(row!.id) })]);
      const own = await b.harness.executeTool<Result>("create-draft", { accountId: "acc-1", subject: "Re: hi", body: "Hi", to: "x@prospect.co.za", purpose: "reply" }, am);
      await b.harness.executeTool<Result>("send-draft", { messageId: own.data!.id }, am);
      expect(b.closed()).toHaveLength(1);
    });
  });
});
