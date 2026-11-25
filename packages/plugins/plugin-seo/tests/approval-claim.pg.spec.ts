/**
 * PAR-14329: the approval-draft claim and the carry-over on the real previews table (embedded Postgres, all migrations).
 * A batch is claimed all or nothing; a job that overlaps another gives back what it took; a page whose draft was sent or
 * deleted in the Mailbox (`mail.draft.closed`) is never carried into a later approval email.
 * PAR-14558: one test per way an older draft can end once its pages were (or were not) carried into a newer one: sent, deleted,
 * replaced, edited and kept by a person, the newer draft failing, and a draft of another sprint of the same client.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { NAMESPACE } from "../src/namespace.js";
import { claimBatch, onDraftClosed, onDraftKept, onDraftResult, openEarlierPreviews, previewsToDraft } from "../src/service/client-signoff.js";
import { createEnv, type Env } from "../src/service/common.js";
import { embeddedAvailable, startPg, type PgHarness } from "./helpers/pg.js";

const available = await embeddedAvailable();
const P = `${NAMESPACE}.previews`;
const sprint = { id: "sp-1", companyId: "co-1" } as never;
const OLD = "seo-approval:sp-1:old";

describe.skipIf(!available)("approval draft claim and carry-over on Postgres", () => {
  let pg: PgHarness;
  let env: Env;

  beforeAll(async () => {
    pg = await startPg();
    env = createEnv(pg.ctx);
    await pg.client.query(`INSERT INTO ${NAMESPACE}.sprints (id, company_id, name, site_url, site_name, start_date) VALUES ('sp-1', 'co-1', 'Acme', 'https://acme.co.za', 'Acme', '2026-11-01'), ('sp-2', 'co-1', 'Acme shop', 'https://shop.acme.co.za', 'Acme shop', '2026-11-01')`);
  }, 60_000);
  afterAll(async () => pg?.stop());
  beforeEach(async () => {
    await pg.client.query(`DELETE FROM ${P}`);
  });

  /** A passed, unanswered preview of its own page; `draft` puts it in an earlier draft. */
  async function preview(id: string, draft: { key: string; status: string; carry?: string } | null = null, sprintId = "sp-1", status = "pending") {
    await pg.client.query(
      `INSERT INTO ${P} (id, company_id, sprint_id, page_url, title, html, status, review_status, reviewed_at, expires_at, draft_key, draft_status, carry_key)
       VALUES ($1, 'co-1', $5, $2, $1, '<html></html>', $6, 'passed', now(), now() + interval '30 days', $3, $4, $7)`,
      [id, `https://acme.co.za/${id}`, draft?.key ?? null, draft?.status ?? null, sprintId, status, draft?.carry ?? null],
    );
  }
  const state = async () =>
    Object.fromEntries(((await pg.client.query(`SELECT id, draft_key, draft_status FROM ${P} ORDER BY id`)).rows as Array<{ id: string; draft_key: string | null; draft_status: string | null }>).map((r) => [r.id, [r.draft_key, r.draft_status]]));
  /** draft_key, draft_status and carry_key of every row. */
  const full = async () =>
    Object.fromEntries(((await pg.client.query(`SELECT id, draft_key, draft_status, carry_key FROM ${P} ORDER BY id`)).rows as Array<Record<string, string | null>>).map((r) => [r.id, [r.draft_key, r.draft_status, r.carry_key]]));

  const carry = (id: string, draftKey: string, carryKey: string | null = null) => ({ id, draftKey, carryKey });

  it("claims new pages and carried pages together: a carried page stays in its draft and only notes the newer one", async () => {
    await preview("e1", { key: OLD, status: "drafted" });
    await preview("p2");
    expect(await claimBatch(env, sprint, "K1", ["p2"], [carry("e1", OLD)])).toBe(true);
    expect(await full()).toEqual({ e1: [OLD, "drafted", "K1"], p2: ["K1", "requested", null] });
  });

  it("an overlapping job with the same pages claims nothing", async () => {
    await preview("p1");
    expect(await claimBatch(env, sprint, "K1", ["p1"], [])).toBe(true);
    expect(await claimBatch(env, sprint, "K2", ["p1"], [])).toBe(false);
    expect(await state()).toEqual({ p1: ["K1", "requested"] });
  });

  it("an overlapping job that gets only part of its batch gives it all back: no page ends in two drafts", async () => {
    await preview("p1");
    await preview("p2");
    await preview("e1", { key: OLD, status: "drafted" });
    expect(await claimBatch(env, sprint, "K1", ["p1"], [])).toBe(true);
    // Job B read p1 as new and e1 as carried before job A claimed p1.
    expect(await claimBatch(env, sprint, "K2", ["p1", "p2"], [carry("e1", OLD)])).toBe(false);
    expect(await full()).toEqual({ e1: [OLD, "drafted", null], p1: ["K1", "requested", null], p2: [null, null, null] });
  });

  it("a carried page is claimed only with the carry it was read with (compare and set); a give-back restores that carry", async () => {
    await preview("e1", { key: OLD, status: "drafted" });
    await preview("p1");
    await preview("p2");
    expect(await claimBatch(env, sprint, "K1", ["p1"], [carry("e1", OLD)])).toBe(true);
    // A second job still holding the stale read of e1 (no carry) cannot take it.
    expect(await claimBatch(env, sprint, "K2", ["p2"], [carry("e1", OLD)])).toBe(false);
    expect(await full()).toMatchObject({ e1: [OLD, "drafted", "K1"], p2: [null, null, null] });
    // With the fresh read it can; giving it back puts K1 back.
    expect(await claimBatch(env, sprint, "K3", ["p2", "p-missing"], [carry("e1", OLD, "K1")])).toBe(false);
    expect(await full()).toMatchObject({ e1: [OLD, "drafted", "K1"], p2: [null, null, null] });
  });

  it("a draft the Mailbox says was sent or deleted is never carried again; another plugin's close is ignored", async () => {
    await preview("sent1", { key: "K-sent", status: "drafted" });
    await preview("del1", { key: "K-del", status: "drafted" });
    await preview("open1", { key: "K-open", status: "drafted" });
    const context = { plugin: "partnersinbiz.seo", kind: "seo-approval", id: "sp-1" };
    await onDraftClosed(env, { companyId: "co-1", payload: { key: "K-sent", status: "sent", mailboxDraftId: "m1", context } });
    await onDraftClosed(env, { companyId: "co-1", payload: { key: "K-del", status: "deleted", mailboxDraftId: "m2", context } });
    await onDraftClosed(env, { companyId: "co-1", payload: { key: "K-open", status: "sent", mailboxDraftId: "m3", context: { ...context, plugin: "partnersinbiz.crm" } } });
    expect((await openEarlierPreviews(env, sprint)).map((p) => [p.id, p.draftKey])).toEqual([["open1", "K-open"]]);
    expect(await state()).toMatchObject({ sent1: ["K-sent", "sent"], del1: ["K-del", "deleted"] });
  });

  describe("every way an older approval draft ends (PAR-14558)", () => {
    const context = { plugin: "partnersinbiz.seo", kind: "seo-approval", id: "sp-1" };
    const closed = (key: string, status: string, replacedBy: string | null = null) => onDraftClosed(env, { companyId: "co-1", payload: { key, status, mailboxDraftId: `m-${key}`, replacedBy, context } });
    const kept = (key: string) => onDraftKept(env, { companyId: "co-1", payload: { key, mailboxDraftId: `m-${key}`, context } });
    const carried = async () => (await openEarlierPreviews(env, sprint)).map((p) => p.id);

    it("replaced: carried pages move into the newer draft; sending the newer one marks every page sent", async () => {
      await preview("e1", { key: OLD, status: "drafted" });
      await preview("p2");
      expect(await claimBatch(env, sprint, "K1", ["p2"], [carry("e1", OLD)])).toBe(true);
      await closed(OLD, "replaced", "K1");
      expect(await full()).toEqual({ e1: ["K1", "requested", null], p2: ["K1", "requested", null] });
      await closed("K1", "sent");
      expect(await full()).toEqual({ e1: ["K1", "sent", null], p2: ["K1", "sent", null] });
    });

    it("replaced with pages no newer draft lists: an unanswered page is freed and asked about again; an answered one is left", async () => {
      await preview("e1", { key: OLD, status: "drafted" });
      await preview("a1", { key: OLD, status: "drafted" }, "sp-1", "approved");
      await closed(OLD, "replaced", "K-other");
      expect(await full()).toEqual({ a1: [OLD, "replaced", null], e1: [null, null, null] });
      expect((await previewsToDraft(env, sprint)).map((p) => p.id)).toEqual(["e1"]);
    });

    it("two sprints of one client: sprint 2's batch never lists sprint 1's pages, and sprint 1's open draft keeps them", async () => {
      await preview("s1", { key: "seo-approval:sp-1:x", status: "drafted" }, "sp-1");
      await preview("s2", null, "sp-2");
      const sprint2 = { id: "sp-2", companyId: "co-1" } as never;
      expect((await openEarlierPreviews(env, sprint2)).map((p) => p.id)).toEqual([]);
      expect(await claimBatch(env, sprint2, "seo-approval:sp-2:y", ["s2"], [])).toBe(true);
      expect(await full()).toEqual({ s1: ["seo-approval:sp-1:x", "drafted", null], s2: ["seo-approval:sp-2:y", "requested", null] });
      expect(await carried()).toEqual(["s1"]);
    });

    it("edited by a person before the next batch: its pages are kept there, not listed again, and marked sent when it is sent", async () => {
      await preview("e1", { key: OLD, status: "drafted" });
      await preview("p2");
      await kept(OLD);
      expect(await carried()).toEqual([]);
      expect(await claimBatch(env, sprint, "K1", ["p2"], [])).toBe(true);
      await closed(OLD, "sent");
      await closed("K1", "sent");
      expect(await full()).toEqual({ e1: [OLD, "sent", null], p2: ["K1", "sent", null] });
    });

    it("edited by a person after its pages were carried (the Mailbox keeps it, no replacement): they stay in it and are marked sent with it", async () => {
      await preview("e1", { key: OLD, status: "drafted" });
      await preview("p2");
      expect(await claimBatch(env, sprint, "K1", ["p2"], [carry("e1", OLD)])).toBe(true);
      await kept(OLD);
      expect(await full()).toEqual({ e1: [OLD, "kept", "K1"], p2: ["K1", "requested", null] });
      await closed(OLD, "sent");
      expect(await full()).toEqual({ e1: [OLD, "sent", null], p2: ["K1", "requested", null] });
      // The newer draft no longer counts e1 among its open pages, and a later batch does not list it.
      expect(await carried()).toEqual([]);
    });

    it("kept older draft, the newer one is sent first: the client has every page it lists, the carried page included", async () => {
      await preview("e1", { key: OLD, status: "drafted" });
      await preview("p2");
      expect(await claimBatch(env, sprint, "K1", ["p2"], [carry("e1", OLD)])).toBe(true);
      await kept(OLD);
      await closed("K1", "sent");
      expect(await full()).toEqual({ e1: [OLD, "sent", null], p2: ["K1", "sent", null] });
    });

    it("deleted by a person: a page a newer open draft lists moves there; any other page is not asked again", async () => {
      await preview("e1", { key: OLD, status: "drafted" });
      await preview("e2", { key: OLD, status: "drafted" });
      await preview("p3");
      expect(await claimBatch(env, sprint, "K1", ["p3"], [carry("e1", OLD)])).toBe(true);
      await closed(OLD, "deleted");
      expect(await full()).toEqual({ e1: ["K1", "requested", null], e2: [OLD, "deleted", null], p3: ["K1", "requested", null] });
    });

    it("the newer draft is deleted while the older one is kept: the carried page stays only in the older one", async () => {
      await preview("e1", { key: OLD, status: "drafted" });
      await preview("p2");
      expect(await claimBatch(env, sprint, "K1", ["p2"], [carry("e1", OLD)])).toBe(true);
      await kept(OLD);
      await closed("K1", "deleted");
      expect(await full()).toEqual({ e1: [OLD, "kept", null], p2: ["K1", "deleted", null] });
    });

    it("a chain of carries: the page follows its latest carry when the drafts before are replaced", async () => {
      await preview("e1", { key: OLD, status: "drafted" });
      await preview("p2");
      await preview("p3");
      expect(await claimBatch(env, sprint, "K1", ["p2"], [carry("e1", OLD)])).toBe(true);
      // The next batch ran before the Mailbox's word on OLD arrived: e1 is carried again, into K2.
      await pg.client.query(`UPDATE ${P} SET draft_status = 'drafted' WHERE draft_key = 'K1'`);
      expect(await claimBatch(env, sprint, "K2", ["p3"], [carry("e1", OLD, "K1"), carry("p2", "K1")])).toBe(true);
      await closed(OLD, "replaced", "K1");
      await closed("K1", "replaced", "K2");
      expect(await full()).toEqual({ e1: ["K2", "requested", null], p2: ["K2", "requested", null], p3: ["K2", "requested", null] });
    });

    it("the newer draft failed: nothing was replaced, so carried pages stay only in the draft they are in", async () => {
      await preview("e1", { key: OLD, status: "drafted" });
      await preview("p2");
      expect(await claimBatch(env, sprint, "K1", ["p2"], [carry("e1", OLD)])).toBe(true);
      // The Needs you part needs the host; the rows are recorded before it.
      await onDraftResult(env, { companyId: "co-1", payload: { key: "K1", status: "failed", error: "No Gmail account", context } }).catch(() => undefined);
      expect(await full()).toEqual({ e1: [OLD, "drafted", null], p2: ["K1", "failed", null] });
    });

    it("a late drafted result never reopens a page that is kept, sent, deleted or replaced", async () => {
      await preview("k1", { key: "K1", status: "kept" });
      await preview("s1", { key: "K1", status: "sent" });
      await preview("r1", { key: "K1", status: "replaced" }, "sp-1", "approved");
      await onDraftResult(env, { companyId: "co-1", payload: { key: "K1", status: "drafted", context } }).catch(() => undefined);
      expect(await full()).toEqual({ k1: ["K1", "kept", null], r1: ["K1", "replaced", null], s1: ["K1", "sent", null] });
    });
  });
});
