import { describe, expect, it } from "vitest";
import type { DoneCheckIssue } from "@partnersinbiz/pib-plugin-kit";
import { checkClientLead, closeStands, CRM_DONE_CHECKS } from "../src/done-checks.js";
import { handleLeadWebhook } from "../src/lead-capture.js";
import { CRM_ORIGINS, originFor, WORK_ORIGIN_RE } from "../src/origins.js";
import { CO, ago, crmIssues, tool } from "./helpers/crm.js";
import { bootLeads, delivery, lead, makeSource } from "./helpers/leads.js";

const issue = (originId: string, createdAt = ago(60)): DoneCheckIssue => ({ id: "iss-1", companyId: CO, identifier: "PIB-1", title: "Lead", originId, assigneeAgentId: "iq-1", createdAt });

async function withClientLead() {
  const booted = await bootLeads();
  const { source } = await makeSource(booted, { client: "company:acme" });
  await handleLeadWebhook(booted.harness.ctx, delivery(lead(source.key)));
  const key = booted.store.client_leads[0]!.key as string;
  return { booted, key, origin: originFor.clientLead(key) };
}
const note = (recordId: string, minutesAgo: number) => ({ id: `a${minutesAgo}`, company_id: CO, record_type: "company", record_id: recordId, kind: "note", body: "handed over", issue_id: null, meta: null, source_key: null, created_at: ago(minutesAgo) });

describe("the client lead issue", () => {
  it("has its own origin prefix, handed to a new Account Manager with the rest of the CRM's work", () => {
    expect(CRM_ORIGINS.clientLead).toBe("crm:client-lead:");
    expect(CRM_DONE_CHECKS.map((rule) => rule.originPrefix)).toContain("crm:client-lead:");
    expect(WORK_ORIGIN_RE.test("crm:client-lead:form:src:abc:20261003")).toBe(true);
    expect(WORK_ORIGIN_RE.test("crm:service-onboard:company:acme:seo:20261003")).toBe(true);
  });

  it("is reopened until something is logged on the client since the lead came in", async () => {
    const { booted, origin } = await withClientLead();
    const result = await checkClientLead(booted.harness.ctx, issue(origin));
    expect(result.done).toBe(false);
    expect(result.missing![0]).toMatch(/Nothing is logged on `company:acme` since this lead came in: say what you did with it/);
    // Before the issue opened does not count; since does.
    booted.store.activities.push(note("acme", 120));
    expect((await checkClientLead(booted.harness.ctx, issue(origin))).done).toBe(false);
    booted.store.activities.push(note("acme", 5));
    expect(await checkClientLead(booted.harness.ctx, issue(origin))).toEqual({ done: true });
  });

  it("stands when the client or the lead is gone", async () => {
    const { booted, origin } = await withClientLead();
    expect(await checkClientLead(booted.harness.ctx, issue("crm:client-lead:nope"))).toEqual({ done: true });
    booted.store.companies = booted.store.companies.filter((row) => row.id !== "acme");
    expect(await checkClientLead(booted.harness.ctx, issue(origin))).toEqual({ done: true });
  });

  it("an agent's close without a note is reopened by the kit, with the same message", async () => {
    const { booted, origin } = await withClientLead();
    expect(await closeStands(booted.harness.ctx, issue(origin))).toBe(false);
    booted.store.activities.push(note("acme", 1));
    expect(await closeStands(booted.harness.ctx, issue(origin))).toBe(true);
    // The issue itself was opened for the Inbound Qualifier, and tells the agent how it is checked.
    const [opened] = await crmIssues(booted.harness);
    expect(opened!.originId).toBe(origin);
    expect(opened!.description).toContain("**Done when** something is logged on `company:acme`");
    void tool;
  });
});
