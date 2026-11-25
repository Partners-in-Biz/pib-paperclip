/**
 * The reads behind the People tab, the Results tab and the "Needs attention" strip against a real Postgres with every
 * migration: the join to the CRM copy and to public.issues, the per-person events, the per-version counts, the open
 * step tasks per campaign and the drafts a person sent back. Each is scoped to its company.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { campaignState, openReviseCampaigns } from "../src/attention.js";
import { NAMESPACE } from "../src/namespace.js";
import { enrollmentPeople, peopleView, resultRows, resultsView, stepTaskCounts } from "../src/people.js";
import { embeddedAvailable, startPg, type PgHarness } from "./helpers/pg.js";

const available = await embeddedAvailable();
const CO = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

describe.skipIf(!available)("campaigns people, results and attention SQL (postgres)", () => {
  let h: PgHarness;
  let ctx: PluginContext;

  beforeAll(async () => {
    h = await startPg();
    ctx = h.ctx;
  }, 60_000);
  afterAll(async () => {
    await h?.stop();
  });

  const q = (sql: string, params: unknown[] = []) => h.client.query(sql, params);
  const contact = (id: string, name: string, emails: string[], company = CO) =>
    q(`INSERT INTO ${NAMESPACE}.crm_contacts (id, company_id, name, emails, updated_at) VALUES ($1, $2, $3, $4, now())`, [id, company, name, emails]);
  const campaign = (id: string, status = "active", company = CO) =>
    q(`INSERT INTO ${NAMESPACE}.campaigns (id, company_id, name, status) VALUES ($1, $2, $1, $3)`, [id, company, status]);
  const enroll = (id: string, campaignId: string, contactId: string, over: { status?: string; position?: number; issue?: string | null; due?: string | null; company?: string } = {}) =>
    q(
      `INSERT INTO ${NAMESPACE}.campaign_enrollments (id, company_id, campaign_id, contact_id, status, step_position, next_due_at, open_issue_id) VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8)`,
      [id, over.company ?? CO, campaignId, contactId, over.status ?? "running", over.position ?? 1, over.due ?? null, over.issue ?? null],
    );
  const issue = (n: number, status: string, over: { identifier?: string; origin?: string; created?: string; company?: string } = {}) =>
    q(
      `INSERT INTO public.issues (id, company_id, identifier, status, origin_kind, origin_id, created_at) VALUES ($1, $2, $3, $4, 'plugin:partnersinbiz.campaigns', $5, $6::timestamptz)`,
      [uuid(n), over.company ?? CO, over.identifier ?? `PAR-${n}`, status, over.origin ?? null, over.created ?? "2026-11-11T05:39:00Z"],
    );
  let eventNo = 0;
  const event = (campaignId: string, enrollmentId: string, type: string, over: { position?: number; variant?: string | null; at?: string; company?: string } = {}) =>
    q(
      `INSERT INTO ${NAMESPACE}.campaign_step_events (id, company_id, campaign_id, enrollment_id, step_position, event_type, variant, occurred_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz)`,
      [`ev-${++eventNo}`, over.company ?? CO, campaignId, enrollmentId, over.position ?? 1, type, over.variant === undefined ? "a" : over.variant, over.at ?? "2026-11-11T06:00:00Z"],
    );

  beforeEach(async () => {
    await h.reset();
    await q(`DELETE FROM ${NAMESPACE}.crm_contacts`);
    eventNo = 0;
    await contact("ada", "Ada Lovelace", ["ada@acme.test", "ada@home.test"]);
    await contact("bob", "Bob Builder", []);
    await campaign("camp");
    await campaign("camp-2");
    await issue(1, "blocked");
    await issue(2, "todo", { created: "2026-11-12T08:00:00Z" });
    await issue(3, "done");
    await enroll("e-ada", "camp", "ada", { issue: uuid(1) });
    await enroll("e-bob", "camp", "bob", { issue: uuid(2) });
    await enroll("e-gone", "camp", "deleted-contact", { status: "stopped" });
    await enroll("e-closed", "camp-2", "ada", { issue: uuid(3) });
  });

  it("lists everyone in one campaign with name, first email, open task and events", async () => {
    await event("camp", "e-gone", "sent");
    await event("camp", "e-gone", "reply", { at: "2026-11-11T09:00:00Z" });
    await event("camp", "e-gone", "reply", { at: "2026-11-11T10:00:00Z" });
    const people = await enrollmentPeople(ctx, CO, "camp");
    expect(people.map((p) => p.enrollmentId).sort()).toEqual(["e-ada", "e-bob", "e-gone"]);
    const by = Object.fromEntries(people.map((p) => [p.enrollmentId, p]));
    expect(by["e-ada"]).toMatchObject({ name: "Ada Lovelace", email: "ada@acme.test", status: "running", task: { id: uuid(1), identifier: "PAR-1", status: "blocked" }, events: [] });
    expect(by["e-bob"]).toMatchObject({ name: "Bob Builder", email: null, task: { identifier: "PAR-2", status: "todo" } });
    expect(by["e-gone"]).toMatchObject({ name: null, email: null, task: null });
    expect(by["e-gone"]!.events).toEqual([
      { type: "sent", stepPosition: 1, count: 1, at: "2026-11-11T06:00:00.000Z" },
      { type: "reply", stepPosition: 1, count: 2, at: "2026-11-11T10:00:00.000Z" },
    ]);
    const view = peopleView(people, [{ position: 1 }], new Date("2026-11-12T12:00:00Z"));
    expect(view.map((p) => [p.enrollmentId, p.state.key])).toEqual([["e-ada", "held"], ["e-bob", "waiting-agent"], ["e-gone", "replied"]]);
  });

  it("a task that is already closed no longer holds the person", async () => {
    const [person] = await enrollmentPeople(ctx, CO, "camp-2");
    expect(person).toMatchObject({ enrollmentId: "e-closed", task: null });
  });

  it("never returns another company's people or events, even for the same campaign id", async () => {
    await contact("eve", "Eve Other", ["eve@other.test"], OTHER);
    await enroll("e-eve", "camp", "eve", { company: OTHER });
    await event("camp", "e-eve", "sent", { company: OTHER });
    expect((await enrollmentPeople(ctx, CO, "camp")).map((p) => p.enrollmentId)).not.toContain("e-eve");
    expect((await enrollmentPeople(ctx, OTHER, "camp")).map((p) => p.enrollmentId)).toEqual(["e-eve"]);
    expect(await resultRows(ctx, CO, "camp")).toEqual([]);
    expect(await resultRows(ctx, OTHER, "camp")).toEqual([{ stepPosition: 1, variant: "a", eventType: "sent", count: 1 }]);
  });

  it("a contact of another company with the same id does not lend its name", async () => {
    await q(`DELETE FROM ${NAMESPACE}.crm_contacts WHERE id = 'ada'`);
    await contact("ada", "Someone Else", ["else@other.test"], OTHER);
    const people = await enrollmentPeople(ctx, CO, "camp");
    expect(people.find((p) => p.enrollmentId === "e-ada")).toMatchObject({ name: null, email: null });
  });

  it("counts results per step and version, and the view adds them up", async () => {
    await event("camp", "e-ada", "sent");
    await event("camp", "e-bob", "sent", { variant: "b" });
    await event("camp", "e-bob", "reply", { variant: "b" });
    await event("camp", "e-ada", "sent", { position: 2 });
    await event("camp", "e-ada", "unsubscribe", { position: 2, variant: null });
    await event("camp-2", "e-closed", "sent");
    const view = resultsView([{ position: 1, subject: "One", variant: "a" }, { position: 1, subject: "One B", variant: "b" }, { position: 2, subject: "Two" }], await resultRows(ctx, CO, "camp"));
    expect(view.totals).toMatchObject({ sent: 3, replies: 1, unsubscribes: 1 });
    expect(view.steps[0]!.versions).toMatchObject({ a: { sent: 1, replies: 0 }, b: { sent: 1, replies: 1 } });
    expect(view.steps[1]!.totals).toMatchObject({ sent: 1, unsubscribes: 1 });
  });

  it("counts open step tasks per campaign: waiting, blocked and the oldest, closed tasks and stopped people left out", async () => {
    await issue(4, "blocked");
    await enroll("e-stopped", "camp", "bob2", { status: "stopped", issue: uuid(4) });
    const counts = await stepTaskCounts(ctx, CO);
    expect([...counts.keys()]).toEqual(["camp"]);
    expect(counts.get("camp")).toEqual({ waiting: 2, blocked: 1, oldestAt: "2026-11-11T05:39:00.000Z" });
    expect((await stepTaskCounts(ctx, OTHER)).size).toBe(0);
    // The same facts through the state: stuck, with the count and the age.
    const state = campaignState({
      status: "active", stepCount: 1, approvalIssueId: null, approvalStatus: null, approvalWithAgent: false, launchError: null,
      stats: { enrolled: 3, running: 2, done: 0 }, sent: 0, tasks: counts.get("camp")!, failedSends: 0, sendsChecked: true, placeholders: [], reviseOpen: false,
    }, new Date("2026-11-12T12:00:00Z"));
    expect(state).toMatchObject({ key: "stuck", detail: "1 email held for 1 day: its task is blocked." });
  });

  it("a task of another company never counts or shows, even when an enrollment points at it", async () => {
    await issue(20, "blocked", { company: OTHER, identifier: "OTH-20" });
    await enroll("e-cross", "camp", "carl", { issue: uuid(20) });
    const cross = (await enrollmentPeople(ctx, CO, "camp")).find((p) => p.enrollmentId === "e-cross")!;
    expect(cross.task).toMatchObject({ identifier: null, status: "todo" });
    expect(JSON.stringify(cross)).not.toContain("OTH-20");
    expect((await stepTaskCounts(ctx, CO)).get("camp")).toMatchObject({ waiting: 2, blocked: 1 });
  });

  it("finds drafts a person sent back by their open revise task, per company", async () => {
    await issue(10, "todo", { origin: "campaigns:revise:camp:approval-1" });
    await issue(11, "done", { origin: "campaigns:revise:camp-2:approval-2" });
    await issue(12, "todo", { origin: "campaigns:step:e-ada:1" });
    await issue(13, "todo", { origin: "campaigns:revise:camp-9:approval-3", company: OTHER });
    expect([...(await openReviseCampaigns(ctx, CO))]).toEqual(["camp"]);
    expect([...(await openReviseCampaigns(ctx, OTHER))]).toEqual(["camp-9"]);
  });
});
