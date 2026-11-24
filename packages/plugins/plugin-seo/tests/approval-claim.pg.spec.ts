/**
 * PAR-14329: the approval-draft claim and the carry-over on the real previews table (embedded Postgres, all migrations).
 * A batch is claimed all or nothing; a job that overlaps another gives back what it took; a page whose draft was sent or
 * deleted in the Mailbox (`mail.draft.closed`) is never carried into a later approval email.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { NAMESPACE } from "../src/namespace.js";
import { claimBatch, onDraftClosed, openEarlierPreviews } from "../src/service/client-signoff.js";
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
    await pg.client.query(`INSERT INTO ${NAMESPACE}.sprints (id, company_id, name, site_url, site_name, start_date) VALUES ('sp-1', 'co-1', 'Acme', 'https://acme.co.za', 'Acme', '2026-11-01')`);
  }, 60_000);
  afterAll(async () => pg?.stop());
  beforeEach(async () => {
    await pg.client.query(`DELETE FROM ${P}`);
  });

  /** A passed, unanswered preview of its own page; `draft` puts it in an earlier draft. */
  async function preview(id: string, draft: { key: string; status: string } | null = null) {
    await pg.client.query(
      `INSERT INTO ${P} (id, company_id, sprint_id, page_url, title, html, status, review_status, reviewed_at, expires_at, draft_key, draft_status)
       VALUES ($1, 'co-1', 'sp-1', $2, $1, '<html></html>', 'pending', 'passed', now(), now() + interval '30 days', $3, $4)`,
      [id, `https://acme.co.za/${id}`, draft?.key ?? null, draft?.status ?? null],
    );
  }
  const state = async () =>
    Object.fromEntries(((await pg.client.query(`SELECT id, draft_key, draft_status FROM ${P} ORDER BY id`)).rows as Array<{ id: string; draft_key: string | null; draft_status: string | null }>).map((r) => [r.id, [r.draft_key, r.draft_status]]));

  it("claims new pages and carried pages together", async () => {
    await preview("e1", { key: OLD, status: "drafted" });
    await preview("p2");
    expect(await claimBatch(env, sprint, "K1", ["p2"], [{ id: "e1", draftKey: OLD }])).toBe(true);
    expect(await state()).toEqual({ e1: ["K1", "requested"], p2: ["K1", "requested"] });
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
    expect(await claimBatch(env, sprint, "K2", ["p1", "p2"], [{ id: "e1", draftKey: OLD }])).toBe(false);
    expect(await state()).toEqual({ e1: [OLD, "drafted"], p1: ["K1", "requested"], p2: [null, null] });
  });

  it("a carried page is re-claimed only from the draft it was read from (compare and set on its key)", async () => {
    await preview("e1", { key: OLD, status: "drafted" });
    expect(await claimBatch(env, sprint, "K1", [], [{ id: "e1", draftKey: OLD }])).toBe(true);
    // A second job still holding the stale read of e1 cannot take it again.
    expect(await claimBatch(env, sprint, "K2", [], [{ id: "e1", draftKey: OLD }])).toBe(false);
    expect(await state()).toEqual({ e1: ["K1", "requested"] });
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
});
