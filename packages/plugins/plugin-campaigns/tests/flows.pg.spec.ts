/**
 * The campaigns flow numbers and the done-check queries against a real
 * Postgres (with a copy of Paperclip's issues table), so the SQL the fake db
 * cannot run is checked for real.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DoneCheckIssue } from "@partnersinbiz/pib-plugin-kit";
import { campaignFlows } from "../src/cockpit.js";
import { checkReply, checkRevise, checkStepIssue } from "../src/donechecks.js";
import { NAMESPACE } from "../src/namespace.js";
import { CAMPAIGN_ORIGINS } from "../src/origins.js";
import { embeddedAvailable, startPg, type PgHarness } from "./helpers/pg.js";

const available = await embeddedAvailable();
const CO = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

describe.skipIf(!available)("campaigns flows and checks (postgres)", () => {
  let h: PgHarness;

  beforeAll(async () => {
    h = await startPg();
  }, 60_000);

  afterAll(async () => {
    await h?.stop();
  });

  beforeEach(async () => {
    await h.reset();
  });

  const q = (sql: string, params: unknown[] = []) => h.client.query(sql, params);
  const addCampaign = (id: string, status: string, extra: { approval?: string | null; company?: string } = {}) =>
    q(`INSERT INTO ${NAMESPACE}.campaigns (id, company_id, name, status, approval_issue_id) VALUES ($1, $2, $3, $4, $5)`, [id, extra.company ?? CO, id, status, extra.approval ?? null]);
  const addEnrollment = (id: string, campaignId: string, status: string, dueSql: string, extra: { position?: number; openIssue?: string | null; contact?: string } = {}) =>
    q(`INSERT INTO ${NAMESPACE}.campaign_enrollments (id, company_id, campaign_id, contact_id, status, step_position, next_due_at, open_issue_id) VALUES ($1, $2, $3, $4, $5, $6, ${dueSql}, $7)`,
      [id, CO, campaignId, extra.contact ?? `ct-${id}`, status, extra.position ?? 1, extra.openIssue ?? null]);
  const addIssue = (id: string, status: string, origin: { kind?: string; id?: string | null } = {}, extra: { company?: string; ageDays?: number } = {}) =>
    q(`INSERT INTO public.issues (id, company_id, status, origin_kind, origin_id, created_at) VALUES ($1, $2, $3, $4, $5, now() - ($6 || ' days')::interval)`,
      [id, extra.company ?? CO, status, origin.kind ?? "plugin:partnersinbiz.campaigns", origin.id ?? null, String(extra.ageDays ?? 0)]);
  const issue = (id: string, originId: string, createdAt: string | null = new Date().toISOString()): DoneCheckIssue => ({ id, companyId: CO, identifier: null, title: "x", originId, assigneeAgentId: "agent", createdAt });

  it("reports drafts, approvals, running campaigns with stuck sends and open replies", async () => {
    // Drafts: none asked, a refused one, one waiting for a person, one approved and launching.
    await addIssue(uuid(1), "cancelled");
    await addIssue(uuid(2), "todo");
    await addIssue(uuid(3), "done");
    await addCampaign("d-new", "draft");
    await addCampaign("d-refused", "draft", { approval: uuid(1) });
    await addCampaign("d-waiting", "draft", { approval: uuid(2) });
    await addCampaign("d-launching", "draft", { approval: uuid(3) });
    await addCampaign("d-other", "draft", { company: OTHER });
    // Running: A has a failed send and a send due 2 days ago; B is on time; P is paused.
    await addCampaign("run-a", "active");
    await addCampaign("run-b", "active");
    await addCampaign("paused", "paused");
    await addEnrollment("e1", "run-a", "running", "now() - interval '3 days'");
    await q(`INSERT INTO ${NAMESPACE}.outbox (key, company_id, event, payload, status, last_error) VALUES ('campaigns:step:e1:1', $1, 'mail.send.requested', '{}'::jsonb, 'failed', 'Gmail not connected')`, [CO]);
    await addEnrollment("e2", "run-a", "running", "now() - interval '2 days'");
    await addEnrollment("e3", "run-a", "running", "now() + interval '2 days'");
    await addEnrollment("e4", "run-a", "stopped", "now() - interval '9 days'");
    await addEnrollment("e5", "run-b", "running", "now() - interval '1 hour'");
    await addEnrollment("e6", "paused", "running", "now() - interval '9 days'");
    // A send that failed on an earlier step no longer counts once the contact moved on.
    await addEnrollment("e7", "run-b", "running", "now() + interval '1 day'", { position: 2 });
    await q(`INSERT INTO ${NAMESPACE}.outbox (key, company_id, event, payload, status) VALUES ('campaigns:step:e7:1', $1, 'mail.send.requested', '{}'::jsonb, 'failed')`, [CO]);
    // Replies: one 3 days old, one legacy (0.4 origin), one done, the CRM's own reply issue, another company's.
    await addIssue(uuid(10), "todo", { id: `${CAMPAIGN_ORIGINS.reply}e1:m1` }, { ageDays: 3 });
    await addIssue(uuid(11), "in_progress", { id: "reply:m0" });
    await addIssue(uuid(12), "done", { id: `${CAMPAIGN_ORIGINS.reply}e2:m2` }, { ageDays: 5 });
    await addIssue(uuid(13), "todo", { kind: "plugin:partnersinbiz.crm", id: "reply:m9" }, { ageDays: 5 });
    await addIssue(uuid(14), "todo", { id: `${CAMPAIGN_ORIGINS.reply}ex:m3` }, { company: OTHER, ageDays: 5 });

    const flows = await campaignFlows(h.ctx, CO);
    expect(flows).toEqual([
      { stage: "campaign.draft", count: 2, stuck: 0 },
      { stage: "campaign.approval", count: 2, stuck: 0 },
      { stage: "campaign.running", count: 2, stuck: 1, stuckReason: "1 failed send, 1 send waiting over a day", oldestDays: 3 },
      { stage: "campaign.replies", count: 2, stuck: 1, stuckReason: "1 open over 2 days", oldestDays: 3 },
    ]);
  });

  it("reports zero for a company with nothing", async () => {
    expect(await campaignFlows(h.ctx, CO)).toEqual([
      { stage: "campaign.draft", count: 0, stuck: 0 },
      { stage: "campaign.approval", count: 0, stuck: 0 },
      { stage: "campaign.running", count: 0, stuck: 0, stuckReason: null, oldestDays: null },
      { stage: "campaign.replies", count: 0, stuck: 0, stuckReason: null, oldestDays: null },
    ]);
  });

  it("checks a step issue against the enrollment", async () => {
    await addCampaign("run-a", "active");
    await addEnrollment("e1", "run-a", "running", "now()", { openIssue: uuid(20) });
    await q(`INSERT INTO ${NAMESPACE}.crm_contacts (id, company_id, name, emails, updated_at) VALUES ('ct-e1', $1, 'Ada Lovelace', ARRAY['ada@acme.test'], now())`, [CO]);
    const open = await checkStepIssue(h.ctx, issue(uuid(20), `${CAMPAIGN_ORIGINS.step}e1:1`), CAMPAIGN_ORIGINS.step);
    expect(open).toEqual({ done: false, missing: ['Ada Lovelace is still on step 1 of campaign "run-a": closing this issue should move them on. Close it again, or cancel it to stop the campaign for them.'] });
    await q(`UPDATE ${NAMESPACE}.campaign_enrollments SET step_position = 2, open_issue_id = NULL WHERE id = 'e1'`);
    expect(await checkStepIssue(h.ctx, issue(uuid(20), `${CAMPAIGN_ORIGINS.step}e1:1`), CAMPAIGN_ORIGINS.step)).toEqual({ done: true });
  });

  it("checks a revise issue: changed after the refusal and asked again", async () => {
    const refusedAt = new Date(Date.now() - 60_000).toISOString();
    await addCampaign("d1", "draft");
    const revise = issue(uuid(30), `${CAMPAIGN_ORIGINS.revise}d1:${uuid(31)}`, refusedAt);
    expect((await checkRevise(h.ctx, revise)).missing).toHaveLength(2);
    await q(`UPDATE ${NAMESPACE}.campaigns SET edited_at = now(), approval_issue_id = $1 WHERE id = 'd1'`, [uuid(32)]);
    h.issues.set(uuid(32), { id: uuid(32), companyId: CO, status: "todo" });
    expect(await checkRevise(h.ctx, revise)).toEqual({ done: true });
    // An edit from before the refusal does not count.
    await q(`UPDATE ${NAMESPACE}.campaigns SET edited_at = now() - interval '1 hour' WHERE id = 'd1'`);
    expect((await checkRevise(h.ctx, revise)).missing).toEqual([expect.stringContaining("has not changed since its approval was refused")]);
  });

  it("checks a reply issue: logged, suppressed, or stopped after the reply", async () => {
    const openedAt = new Date(Date.now() - 60_000).toISOString();
    await addCampaign("run-a", "active");
    await addEnrollment("e1", "run-a", "running", "now()");
    await q(`INSERT INTO ${NAMESPACE}.crm_contacts (id, company_id, name, emails, updated_at) VALUES ('ct-e1', $1, 'Ada Lovelace', ARRAY['ada@acme.test'], now())`, [CO]);
    const reply = issue(uuid(40), `${CAMPAIGN_ORIGINS.reply}e1:m-1`, openedAt);
    expect((await checkReply(h.ctx, reply)).done).toBe(false);

    await q(`INSERT INTO ${NAMESPACE}.reply_log (id, company_id, message_id, campaign_id, enrollment_id, outcome, note) VALUES ('l1', $1, 'm-1', 'run-a', 'e1', 'answered', 'Drafted')`, [CO]);
    expect(await checkReply(h.ctx, reply)).toEqual({ done: true });
    await q(`DELETE FROM ${NAMESPACE}.reply_log`);

    await q(`INSERT INTO ${NAMESPACE}.suppressions (company_id, email, reason) VALUES ($1, 'ada@acme.test', 'unsubscribe')`, [CO]);
    expect(await checkReply(h.ctx, reply)).toEqual({ done: true });
    await q(`DELETE FROM ${NAMESPACE}.suppressions`);

    await q(`UPDATE ${NAMESPACE}.campaign_enrollments SET status = 'stopped', updated_at = now() - interval '1 hour' WHERE id = 'e1'`);
    expect((await checkReply(h.ctx, reply)).done).toBe(false);
    await q(`UPDATE ${NAMESPACE}.campaign_enrollments SET updated_at = now() WHERE id = 'e1'`);
    expect(await checkReply(h.ctx, reply)).toEqual({ done: true });
  });
});
