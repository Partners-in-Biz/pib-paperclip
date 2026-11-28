/**
 * Email cards on a planning canvas (PAR-14389 C.2 Mailbox row, E paths 1 and 8, PAR-14421) on a real Postgres with every migration,
 * through the real worker. Covers the two new statements (`messagesByIds`, `mailForClient`: client ref OR address, domain match, the
 * ordering, the limit, drafts and Trash left out, a second company) and page parity: a card shows exactly when the same person can
 * open the mail through `mailbox.get-message`, and never its body.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { accessCompanyScope } from "@partnersinbiz/pib-plugin-kit";
import { SqlStore } from "../src/db.js";
import manifest from "../src/manifest.js";
import { NAMESPACE } from "../src/namespace.js";
import plugin from "../src/worker.js";
import { ENCRYPTION_KEY } from "./helpers/memory.js";
import { embeddedAvailable, startPg, type PgHarness } from "./helpers/pg.js";

const available = await embeddedAvailable();

const CO = "co-1";
const CO2 = "co-2";
const CRM = "partnersinbiz.crm";
const BODY = "BODY-TEXT-never-on-a-card";
const SNIPPET = "SNIPPET-TEXT-never-on-a-card";

type Actor = { type: "user" | "agent"; userId?: string; agentId?: string; onBehalfOfUserId?: string; onBehalfOfRestricted?: boolean };
const person = (userId: string, restricted = false): Actor => ({ type: "user", userId, onBehalfOfUserId: userId, onBehalfOfRestricted: restricted });
const ADMIN = person("user-admin");
const MEMBER = person("user-member");
const REFUSED = person("user-refused", true);

/** A card as the actions answer it: a summary or `{ type, id, hidden: true }`. */
interface Card {
  type: string;
  id: string;
  hidden?: true;
  title?: string;
  subtitle?: string;
  status?: string;
  meta?: Array<{ label: string; value: string }>;
  href?: string;
}
interface Group {
  relation: string;
  label: string;
  type: string;
  cards: Card[];
  more: boolean;
}
/** What `mailbox.get-message` answers (the fields this spec reads). */
interface Opened {
  subject: string;
  text?: string;
  withheld?: boolean;
}

interface Mail {
  id: string;
  company?: string;
  direction?: "inbound" | "outbound";
  status?: "synced" | "draft" | "queued" | "sent";
  subject?: string;
  from?: string | null;
  replyTo?: string | null;
  to?: string[];
  cc?: string[];
  bcc?: string[];
  labels?: string[];
  received?: string | null;
  created?: string;
  client?: [kind: string, ref: string];
  privateSend?: boolean;
}

describe.skipIf(!available)("email cards (real Postgres)", () => {
  let pg: PgHarness;

  beforeAll(async () => {
    pg = await startPg();
  }, 180_000);
  afterAll(async () => {
    await pg?.stop();
  });
  beforeEach(async () => {
    await pg.reset();
  });

  const sql = (text: string, params: unknown[] = []) => pg.client.query(text, params);
  const addr = (email: string) => ({ email, name: null });

  async function mail(m: Mail) {
    const company = m.company ?? CO;
    await sql(
      `INSERT INTO ${NAMESPACE}.messages (id, company_id, account_id, subject, body, snippet, direction, status, from_addr, reply_to_addr, to_addrs, cc_addrs, bcc_addrs, labels,
         received_at, created_at, client_kind, client_ref, sent_context)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11::jsonb, $12::jsonb, $13::jsonb, $14::jsonb, $15::timestamptz, $16::timestamptz, $17, $18, $19::jsonb)`,
      [
        m.id, company, company === CO ? "acc-1" : "acc-2", m.subject ?? `Subject ${m.id}`, BODY, SNIPPET, m.direction ?? "inbound", m.status ?? (m.direction === "outbound" ? "sent" : "synced"),
        m.from === undefined ? JSON.stringify(addr("someone@elsewhere.net")) : m.from === null ? null : JSON.stringify(addr(m.from)),
        m.replyTo ? JSON.stringify(addr(m.replyTo)) : null,
        JSON.stringify((m.to ?? []).map(addr)), JSON.stringify((m.cc ?? []).map(addr)), JSON.stringify((m.bcc ?? []).map(addr)), JSON.stringify(m.labels ?? []),
        m.received === undefined ? "2026-10-01T00:00:00Z" : m.received, m.created ?? "2026-09-01T00:00:00Z",
        m.client?.[0] ?? null, m.client?.[1] ?? null,
        m.privateSend ? JSON.stringify({ plugin: CRM, kind: "client_message", id: "approval-1" }) : null,
      ],
    );
  }

  async function seedClients() {
    await sql(`INSERT INTO ${NAMESPACE}.accounts (id, company_id, provider, address) VALUES ('acc-1', $1, 'gmail', 'team@ours.co'), ('acc-2', $2, 'gmail', 'team@theirs.co')`, [CO, CO2]);
    await sql(
      `INSERT INTO ${NAMESPACE}.crm_companies (id, company_id, name, domain, updated_at, deleted) VALUES
         ('cc-1', $1, 'Client Co', 'https://www.Client.co.za/', now(), false),
         ('cc-free', $1, 'Free Mail Co', 'gmail.com', now(), false),
         ('cc-gone', $1, 'Gone Co', 'gone.co', now(), true),
         ('cc-2', $2, 'Theirs Co', 'client.co.za', now(), false)`,
      [CO, CO2],
    );
    await sql(`INSERT INTO ${NAMESPACE}.crm_contacts (id, company_id, name, emails, updated_at) VALUES ('ct-1', $1, 'Ada', ARRAY['Ada@Person.org'], now())`, [CO]);
  }

  /** The mail of Client Co (cc-1), newest first by COALESCE(received_at, created_at), and the mail that must stay out. */
  async function seedMail() {
    await seedClients();
    await mail({ id: "m-private", direction: "outbound", to: ["ceo@client.co.za"], subject: "Please sign", received: null, created: "2026-11-07T09:00:00Z", privateSend: true });
    await mail({ id: "m-bcc", direction: "outbound", to: ["x@y.org"], bcc: ["b@client.co.za"], received: "2026-11-06T09:00:00Z", created: "2026-08-01T00:00:00Z" });
    await mail({ id: "m-from", from: "Bob@CLIENT.co.za", received: "2026-11-05T09:00:00Z" });
    await mail({ id: "m-to", direction: "outbound", to: ["ceo@client.co.za", "two@x.org"], received: null, created: "2026-11-04T09:00:00Z" });
    await mail({ id: "m-replyto", from: "forms@webhost.net", replyTo: "ann@client.co.za", received: "2026-11-03T09:00:00Z" });
    await mail({ id: "m-cc", direction: "outbound", to: ["x@y.org"], cc: ["c@client.co.za"], received: "2026-11-02T09:00:00Z" });
    await mail({ id: "m-tag", from: "relay@unrelated.net", client: ["company", "cc-1"], received: "2026-11-01T09:00:00Z" });
    // Out: a draft, Trash, a subdomain (the domain part must equal), a tag of another kind, unrelated mail, and the same mail in another company.
    await mail({ id: "m-draft", direction: "outbound", status: "draft", to: ["ceo@client.co.za"], received: null, created: "2026-11-08T09:00:00Z" });
    await mail({ id: "m-trash", from: "bob@client.co.za", labels: ["INBOX", "TRASH"], received: "2026-11-08T10:00:00Z" });
    await mail({ id: "m-sub", from: "x@mail.client.co.za", received: "2026-11-08T11:00:00Z" });
    await mail({ id: "m-kind", from: "relay@unrelated.net", client: ["contact", "cc-1"], received: "2026-11-08T12:00:00Z" });
    await mail({ id: "m-other", from: "nobody@unrelated.net", received: "2026-11-08T13:00:00Z" });
    await mail({ id: "m-co2", company: CO2, from: "bob@client.co.za", client: ["company", "cc-1"], received: "2026-11-09T09:00:00Z" });
    // Ada (contact ct-1): by address, any case, and by tag.
    await mail({ id: "m-ada", from: "ADA@person.org", received: "2026-11-02T10:00:00Z" });
    await mail({ id: "m-ada-tag", from: "relay@unrelated.net", client: ["contact", "ct-1"], received: "2026-11-01T10:00:00Z" });
    // A free-mail address must not tie mail to a company whose CRM domain is gmail.com.
    await mail({ id: "m-gmail", from: "someone@gmail.com", received: "2026-11-01T11:00:00Z" });
  }

  const CLIENT_CO_MAIL = ["m-private", "m-bcc", "m-from", "m-to", "m-replyto", "m-cc", "m-tag"];

  async function boot() {
    const harness = createTestHarness({ manifest, config: { publicBaseUrl: "https://paperclip.example.com", encryptionKey: ENCRYPTION_KEY } });
    harness.seed({ companies: [{ id: CO, name: "Co", issuePrefix: "CO" } as never, { id: CO2, name: "Co 2", issuePrefix: "CT" } as never] });
    (harness.ctx as unknown as { db: unknown }).db = pg.db;
    await plugin.definition.setup(harness.ctx);
    // Setup's access row is stored (off), so a restricted member reaches the card helper (H3a refuses him with no row).
    for (const co of [CO, CO2]) await harness.ctx.state.set(accessCompanyScope(co), { mode: "off", rev: 1, userIds: [], receivedAt: new Date().toISOString() });
    const act = <T = Record<string, unknown>>(key: string, params: Record<string, unknown>, actor: Actor = ADMIN, companyId = CO) =>
      harness.performAction<T>(key, params, { companyId, actor } as never);
    const resolve = async (ids: string[], actor: Actor = ADMIN, companyId = CO) =>
      (await act<{ cards: Card[] }>("canvas.cards.resolve", { items: ids.map((id) => ({ type: "card-mail", id })) }, actor, companyId)).cards;
    const related = async (of: { plugin?: string; type: string; id: string }, actor: Actor = ADMIN, limit?: number, companyId = CO) =>
      (await act<{ groups: Group[] }>("canvas.cards.related", { of: { plugin: CRM, ...of }, ...(limit ? { limit } : {}) }, actor, companyId)).groups;
    /** What the Mailbox page's detail action gives the same person: the answer, or null when it refuses. */
    const page = async (id: string, actor: Actor = ADMIN, companyId = CO) => act<Opened>("mailbox.get-message", { messageId: id }, actor, companyId).catch(() => null);
    return { harness, act, resolve, related, page };
  }

  describe("the new store statements", () => {
    it("mailForClient: client ref OR an address in from, reply-to, to, cc or bcc; a domain on the part after @; newest first; drafts, Trash and the other company left out", async () => {
      await seedMail();
      const store = new SqlStore(pg.db);
      const company = await store.mailForClient(CO, { kind: "company", id: "cc-1", emails: [], domains: ["client.co.za"] });
      expect(company.map((r) => r.id)).toEqual(CLIENT_CO_MAIL);
      const contact = await store.mailForClient(CO, { kind: "contact", id: "ct-1", emails: ["Ada@Person.org"], domains: [] });
      expect(contact.map((r) => r.id)).toEqual(["m-ada", "m-ada-tag"]);
      // The tag alone, with no address or domain to match.
      expect((await store.mailForClient(CO, { kind: "company", id: "cc-1", emails: [], domains: [] })).map((r) => r.id)).toEqual(["m-tag"]);
      // The second company sees only its own.
      expect((await store.mailForClient(CO2, { kind: "company", id: "cc-1", emails: [], domains: ["client.co.za"] })).map((r) => r.id)).toEqual(["m-co2"]);
    });

    it("mailForClient: at most 50 rows, the newest, and a smaller limit is kept", async () => {
      await seedClients();
      for (let i = 0; i < 55; i++) await mail({ id: `many-${String(i).padStart(2, "0")}`, from: `p${i}@many.co`, received: new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString() });
      const store = new SqlStore(pg.db);
      const rows = await store.mailForClient(CO, { kind: "company", id: "cc-many", emails: [], domains: ["many.co"] });
      expect(rows).toHaveLength(50);
      expect(rows[0]!.id).toBe("many-54");
      expect(rows[49]!.id).toBe("many-05");
      expect((await store.mailForClient(CO, { kind: "company", id: "cc-many", emails: [], domains: ["many.co"] }, 500)).length).toBe(50);
      expect((await store.mailForClient(CO, { kind: "company", id: "cc-many", emails: [], domains: ["many.co"] }, 3)).map((r) => r.id)).toEqual(["many-54", "many-53", "many-52"]);
    });

    it("messagesByIds: only this company's messages among the ids", async () => {
      await seedMail();
      const store = new SqlStore(pg.db);
      const rows = await store.messagesByIds(CO, ["m-from", "m-co2", "nope", "m-draft"]);
      expect(rows.map((r) => r.id).sort()).toEqual(["m-draft", "m-from"]);
      expect((await store.messagesByIds(CO2, ["m-from", "m-co2"])).map((r) => r.id)).toEqual(["m-co2"]);
      expect(await store.messagesByIds(CO, [])).toEqual([]);
    });
  });

  describe("resolve: path 1 and 8, and parity with mailbox.get-message", () => {
    it("another company's id, an unknown id and a deleted mail are hidden; the same id resolves in its own company", async () => {
      await seedMail();
      const b = await boot();
      await b.act("mailbox.delete-mail", { messageId: "m-cc" });
      const cards = await b.resolve(["m-co2", "nope", "m-cc", "m-from"]);
      expect(cards.slice(0, 3)).toEqual([
        { type: "card-mail", id: "m-co2", hidden: true },
        { type: "card-mail", id: "nope", hidden: true },
        { type: "card-mail", id: "m-cc", hidden: true },
      ]);
      expect(cards[3]).toMatchObject({ id: "m-from", title: "Subject m-from" });
      expect((await b.resolve(["m-co2"], person("user-theirs"), CO2))[0]).toMatchObject({ id: "m-co2", title: "Subject m-co2" });
    });

    it("record by record, for an admin, a plain member and a member the page refuses, a card shows exactly what get-message opens", async () => {
      await seedMail();
      const b = await boot();
      const ids = [...CLIENT_CO_MAIL, "m-draft", "m-trash", "m-co2", "nope"];
      for (const actor of [ADMIN, MEMBER]) {
        const cards = await b.resolve(ids, actor);
        for (const card of cards) {
          const opened = await b.page(card.id, actor);
          expect(card.hidden === true, `${actor.userId} ${card.id}`).toBe(opened === null);
          if (opened) expect(card.title).toBe(opened.subject);
        }
      }
      // A restricted member: core refuses him the page (plugin gate) and the card actions; the kit answers hidden without reading mail.
      expect((await b.resolve(ids, REFUSED)).every((card) => card.hidden === true)).toBe(true);
    });

    it("a card shows subject, the other party, the date and sent or received; never the body or the snippet; a client message its subject only", async () => {
      await seedMail();
      const b = await boot();
      const [from, to, priv, draft] = await b.resolve(["m-from", "m-to", "m-private", "m-draft"]);
      expect(from).toEqual({ type: "card-mail", id: "m-from", title: "Subject m-from", subtitle: "From Bob@CLIENT.co.za", status: "Received", meta: [{ label: "Date", value: "2026-11-05" }], href: "/mailbox?tab=inbox&mail=m-from" });
      expect(to).toMatchObject({ subtitle: "To ceo@client.co.za", status: "Sent", meta: [{ label: "Date", value: "2026-11-04" }] });
      expect(priv).toEqual({ type: "card-mail", id: "m-private", title: "Please sign", href: "/mailbox?tab=inbox&mail=m-private" });
      // The page withholds the client message's text too.
      expect(await b.page("m-private")).toMatchObject({ subject: "Please sign", withheld: true, text: "" });
      expect(draft).toMatchObject({ status: "Draft" });
      const all = JSON.stringify(await b.resolve([...CLIENT_CO_MAIL, "m-draft", "m-trash"]));
      expect(all).not.toContain(BODY);
      expect(all).not.toContain(SNIPPET);
    });
  });

  describe("related", () => {
    it("a CRM company: its mail, newest first, every id readable through get-message by the same person; a contact by its addresses", async () => {
      await seedMail();
      const b = await boot();
      for (const actor of [ADMIN, MEMBER]) {
        const [group, ...rest] = await b.related({ type: "card-company", id: "cc-1" }, actor);
        expect(rest).toEqual([]);
        expect(group).toMatchObject({ relation: "emails", label: "Emails", type: "card-mail", more: false });
        expect(group!.cards.map((c) => c.id)).toEqual(CLIENT_CO_MAIL);
        for (const card of group!.cards) expect(await b.page(card.id, actor), card.id).not.toBeNull();
        expect(JSON.stringify(group)).not.toContain(BODY);
      }
      const [contact] = await b.related({ type: "card-contact", id: "ct-1" });
      expect(contact!.cards.map((c) => c.id)).toEqual(["m-ada", "m-ada-tag"]);
    });

    it("an `of` the person cannot see in the CRM: the Mailbox answers what its own page shows him (company-wide), nothing more", async () => {
      await seedMail();
      const b = await boot();
      // The Mailbox has no per-person CRM rule: the plain member gets the admin's set, and each of those he can open on the Mailbox page.
      const member = (await b.related({ type: "card-company", id: "cc-1" }, MEMBER))[0]!.cards.map((c) => c.id);
      expect(member).toEqual((await b.related({ type: "card-company", id: "cc-1" }, ADMIN))[0]!.cards.map((c) => c.id));
      for (const id of member) expect(await b.page(id, MEMBER)).not.toBeNull();
      // A record of another company, a deleted record, an unknown one, a non-CRM `of` and a free-mail domain give nothing.
      expect(await b.related({ type: "card-company", id: "cc-2" })).toEqual([]);
      expect(await b.related({ type: "card-company", id: "cc-gone" })).toEqual([]);
      expect(await b.related({ type: "card-contact", id: "nope" })).toEqual([]);
      expect(await b.related({ plugin: "partnersinbiz.billing", type: "card-company", id: "cc-1" })).toEqual([]);
      expect(await b.related({ type: "card-invoice", id: "cc-1" })).toEqual([]);
      expect((await b.related({ type: "card-company", id: "cc-free" }))[0]!.cards).toEqual([]);
      // In the second company its own client answers that company's mail only.
      expect((await b.related({ type: "card-company", id: "cc-2" }, person("user-theirs"), undefined, CO2))[0]!.cards.map((c) => c.id)).toEqual(["m-co2"]);
      // A restricted member gets no groups.
      expect(await b.related({ type: "card-company", id: "cc-1" }, REFUSED)).toEqual([]);
    });

    it("cut to the asked limit with `more`; 50 rows at most", async () => {
      await seedClients();
      await sql(`INSERT INTO ${NAMESPACE}.crm_companies (id, company_id, name, domain, updated_at) VALUES ('cc-many', $1, 'Many', 'many.co', now())`, [CO]);
      for (let i = 0; i < 55; i++) await mail({ id: `many-${String(i).padStart(2, "0")}`, from: `p${i}@many.co`, received: new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString() });
      const b = await boot();
      const [all] = await b.related({ type: "card-company", id: "cc-many" });
      expect(all!.cards).toHaveLength(50);
      expect(all!.more).toBe(true);
      const [five] = await b.related({ type: "card-company", id: "cc-many" }, ADMIN, 5);
      expect(five!.cards.map((c) => c.id)).toEqual(["many-54", "many-53", "many-52", "many-51", "many-50"]);
      expect(five!.more).toBe(true);
    });
  });
});
