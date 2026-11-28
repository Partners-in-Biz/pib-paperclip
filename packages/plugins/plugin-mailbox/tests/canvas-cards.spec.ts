/**
 * Email cards (PAR-14389 C.2, PAR-14421) without a database: the manifest slot, the registration through the kit helper (the core
 * sweep checks the other direction), the refused callers never reaching the store, and what a card may carry.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { accessCompanyScope } from "@partnersinbiz/pib-plugin-kit";
import { mailCard, mailHref } from "../src/canvas-cards.js";
import type { MessageRow } from "../src/gmail/types.js";
import manifest from "../src/manifest.js";
import { NAMESPACE } from "../src/namespace.js";
import plugin from "../src/worker.js";
import { boardBatcher } from "../src/ui/board-batcher.js";
import { CO, ENCRYPTION_KEY } from "./helpers/memory.js";

const src = (path: string) => readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");

/** The worker over a database that records every statement and answers none: a refused call must not read mail. */
async function boot() {
  const harness = createTestHarness({ manifest, config: { publicBaseUrl: "https://paperclip.example.com", encryptionKey: ENCRYPTION_KEY } });
  const queries: string[] = [];
  const db = {
    namespace: NAMESPACE,
    async query(sql: string) {
      queries.push(sql);
      return [];
    },
    async execute() {
      return { rowCount: 0 };
    },
  };
  (harness.ctx as unknown as { db: typeof db }).db = db;
  await plugin.definition.setup(harness.ctx);
  queries.length = 0;
  const act = (key: string, params: Record<string, unknown>, actor: Record<string, unknown>) => harness.performAction<Record<string, unknown>>(key, params, { companyId: CO, actor } as never);
  const mailQueries = () => queries.filter((sql) => sql.includes(`${NAMESPACE}.messages`) || sql.includes(`${NAMESPACE}.crm_`));
  const storeAccessRow = () => harness.ctx.state.set(accessCompanyScope(CO), { mode: "off", rev: 1, userIds: [], receivedAt: new Date().toISOString() });
  return { act, mailQueries, storeAccessRow };
}

const items = { items: [{ type: "card-mail", id: "m-1" }] };
const of = { of: { plugin: "partnersinbiz.crm", type: "card-company", id: "cc-1" } };

describe("the email card slot and its registration", () => {
  it("the manifest declares the card-mail canvasNode slot with entityCard (no search, related), exported by the UI", () => {
    const slot = manifest.ui?.slots?.find((s) => s.id === "card-mail");
    expect(slot).toEqual({ type: "canvasNode", id: "card-mail", displayName: "Email", exportName: "MailCanvasCard", entityCard: { kind: "mail", search: false, related: true } });
    expect(src("ui/index.tsx")).toMatch(/export \{ MailCanvasCard \} from "\.\/canvas-card\.js";/);
  });

  it("the worker registers through registerCanvasCards with the access guard (g.action), not the user wrapper", () => {
    expect(src("worker.ts")).toMatch(/registerCanvasCards\(\{ register: g\.action, kinds: \[mailCardKind\(/);
  });

  it("resolve and related answer; search is not registered, so the key is refused", async () => {
    const { act } = await boot();
    const user = { type: "user", userId: "u1", onBehalfOfUserId: "u1", onBehalfOfRestricted: false };
    expect(await act("canvas.cards.resolve", items, user)).toEqual({ cards: [{ type: "card-mail", id: "m-1", hidden: true }] });
    expect(await act("canvas.cards.related", of, user)).toEqual({ groups: [] });
    await expect(act("canvas.cards.search", { type: "card-mail", q: "invoice" }, user)).rejects.toThrow(/No action handler registered for 'canvas\.cards\.search'/);
  });
});

describe("refused callers never reach the mail", () => {
  it("an agent: CANVAS_CARDS_PERSON_ONLY", async () => {
    const { act, mailQueries } = await boot();
    const agent = { type: "agent", agentId: "agent-1", runId: "run-1" };
    expect(await act("canvas.cards.resolve", items, agent)).toMatchObject({ ok: false, refused: true, code: "CANVAS_CARDS_PERSON_ONLY" });
    expect(await act("canvas.cards.related", of, agent)).toMatchObject({ ok: false, refused: true, code: "CANVAS_CARDS_PERSON_ONLY" });
    expect(mailQueries()).toEqual([]);
  });

  it("a restricted member: hidden and no groups; a missing restriction answer: MEMBER_RESTRICTION_UNAVAILABLE", async () => {
    const { act, mailQueries, storeAccessRow } = await boot();
    const restricted = { type: "user", userId: "u2", onBehalfOfUserId: "u2", onBehalfOfRestricted: true };
    // H3a: with no access row in this plugin, the guard refuses him before the card helper is asked.
    expect(await act("canvas.cards.resolve", items, restricted)).toMatchObject({ refused: true, code: "PERMISSION_DENIED" });
    await storeAccessRow();
    expect(await act("canvas.cards.resolve", items, restricted)).toEqual({ cards: [{ type: "card-mail", id: "m-1", hidden: true }] });
    expect(await act("canvas.cards.related", of, restricted)).toEqual({ groups: [] });
    expect(await act("canvas.cards.resolve", items, { type: "user", userId: "u3" })).toMatchObject({ refused: true, code: "MEMBER_RESTRICTION_UNAVAILABLE" });
    expect(mailQueries()).toEqual([]);
  });
});

const row = (over: Partial<MessageRow> = {}): MessageRow => ({
  id: "m/1?x",
  direction: "inbound",
  status: "synced",
  subject: "Quote for the new site",
  body: "BODY",
  snippet: "SNIPPET",
  from_addr: { email: "ann@client.co.za", name: "Ann" },
  to_addrs: [{ email: "team@ours.co", name: null }],
  created_at: "2026-11-01T08:00:00.000Z",
  received_at: "2026-11-02T08:00:00.000Z",
  ...over,
}) as MessageRow;

describe("what a card carries", () => {
  it("subject, the other party, the date and sent or received; never the body or snippet", () => {
    const card = mailCard(row(), false);
    expect(card).toEqual({ id: "m/1?x", title: "Quote for the new site", subtitle: "From ann@client.co.za", status: "Received", meta: [{ label: "Date", value: "2026-11-02" }], href: "/mailbox?tab=inbox&mail=m%2F1%3Fx" });
    expect(JSON.stringify(card)).not.toMatch(/BODY|SNIPPET|Ann"/);
    expect(mailCard(row({ direction: "outbound", status: "sent", received_at: null, to_addrs: [{ email: "", name: null }, { email: "bob@client.co.za", name: null }] }), false)).toMatchObject({
      subtitle: "To bob@client.co.za",
      status: "Sent",
      meta: [{ label: "Date", value: "2026-11-01" }],
    });
    const queued = mailCard(row({ direction: "outbound", status: "queued", to_addrs: [] }), false);
    expect(queued).toMatchObject({ status: "Sending", subtitle: null, meta: [{ label: "Date", value: "2026-11-02" }] });
    expect(mailCard(row({ direction: "outbound", status: "draft" }), false).status).toBe("Draft");
    expect(mailCard(row({ subject: "   " }), false).title).toBe("(no subject)");
    const long = mailCard(row({ subject: `Re: Fwd: ${"quotation ".repeat(30)}` }), false).title;
    expect(long).toHaveLength(120);
    expect(long.endsWith("…")).toBe(true);
  });

  it("a client message: its subject only", () => {
    expect(mailCard(row(), true)).toEqual({ id: "m/1?x", title: "Quote for the new site", href: mailHref("m/1?x") });
  });
});

describe("one batcher per open board", () => {
  it("cards of one board share a batcher and the newest resolve; another board starts a new one", async () => {
    const asked: string[] = [];
    let made = 0;
    // A stand-in for createCardBatcher (the real one is tested in pib-plugin-ui): it asks through the resolve it was given.
    const create = (resolve: (params: { items: { type: string; id: string }[] }) => Promise<unknown>) => {
      made++;
      return { load: async (type: string, id: string) => (await resolve({ items: [{ type, id }] }), { state: "hidden" as const }), retry: async () => ({ state: "hidden" as const }) };
    };
    const answer = (tag: string) => async (params: { items: { type: string; id: string }[] }) => {
      asked.push(`${tag}:${params.items.map((i) => i.id).join(",")}`);
      return { cards: [] };
    };
    const a = boardBatcher("co\u0000board-a", answer("first"), create);
    expect(boardBatcher("co\u0000board-a", answer("second"), create)).toBe(a);
    await a.load("card-mail", "m-1");
    expect(asked).toEqual(["second:m-1"]);
    expect(made).toBe(1);
    expect(boardBatcher("co\u0000board-b", answer("third"), create)).not.toBe(a);
    expect(made).toBe(2);
  });
});
