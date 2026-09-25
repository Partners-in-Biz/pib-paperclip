import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { NAMESPACE } from "../src/namespace.js";
import {
  advanceEnrollment,
  applyFieldPatch,
  canCompleteStep,
  canSeeRecord,
  columnKeysFor,
  createAccount,
  createContact,
  assertMergeTargets,
  createProduct,
  forecastPipeline,
  createSavedView,
  parseCsv,
  toCsv,
  isDuplicatePair,
  linkContact,
  scoreBand,
  scoreContact,
  requireVisible,
  startEnrollment,
  stopRunningEnrollments,
} from "../src/domain.js";

const viewer = {
  companyId: "workspace-a",
  userId: "user-1",
  agentId: "agent-1",
  role: "operator" as string | null,
};

describe("crm schema", () => {
  it("keeps the host namespace for partnersinbiz.crm", () => {
    expect(NAMESPACE).toBe("plugin_crm_832258244c");
    const sql = readFileSync(new URL("../migrations/001_crm.sql", import.meta.url), "utf8");
    for (const table of [
      "companies",
      "contacts",
      "contact_companies",
      "field_defs",
      "facts",
      "activities",
      "pipelines",
      "pipeline_stages",
      "deals",
      "record_grants",
      "sequences",
      "sequence_steps",
      "enrollments",
    ]) {
      expect(sql).toContain(`CREATE TABLE ${NAMESPACE}.${table}`);
    }
    expect(sql).toContain("amount_minor");
    expect(sql).not.toContain("amount_cents");
    expect(sql).toContain("WHERE status = 'running'");
  });
});

describe("crm records", () => {
  it("creates a company and links two contacts", () => {
    const account = createAccount({ companyId: "workspace-a", name: "Northwind", domain: "northwind.test" });
    const ada = createContact({ companyId: "workspace-a", name: "Ada Lovelace", emails: ["ada@northwind.test"] });
    const grace = createContact({ companyId: "workspace-a", name: "Grace Hopper" });
    const links = [
      linkContact({ companyId: "workspace-a", contactId: ada.id, accountId: account.id, roleLabel: "buyer" }),
      linkContact({ companyId: "workspace-a", contactId: grace.id, accountId: account.id, roleLabel: "staff" }),
    ];
    expect(links.map((link) => link.roleLabel)).toEqual(["buyer", "staff"]);
    expect(new Set(links.map((link) => link.contactId)).size).toBe(2);
  });

  it("fails a write to a filled human-owned field and keeps the current value", () => {
    const result = applyFieldPatch({
      columns: { name: "Ada" },
      custom: { plan: "kept" },
      humanOwned: ["name", "plan"],
      columnKeys: columnKeysFor("contact"),
      patch: { name: "Grace", plan: "replaced", city: "London" },
      source: "agent",
    });
    expect(result.refused).toEqual(["name", "plan"]);
    expect(result.columns.name).toBe("Ada");
    expect(result.custom.plan).toBe("kept");
    expect(result.custom.city).toBe("London");
    expect(result.facts.filter((fact) => fact.refused)).toHaveLength(2);
  });

  it("lets an agent fill an empty human-owned field", () => {
    const result = applyFieldPatch({
      columns: { name: "" },
      custom: {},
      humanOwned: ["name"],
      columnKeys: columnKeysFor("contact"),
      patch: { name: "Ada" },
      source: "agent",
    });
    expect(result.refused).toEqual([]);
    expect(result.columns.name).toBe("Ada");
  });
});

describe("crm visibility", () => {
  const record = { companyId: "workspace-a", ownerUserId: "owner-user", assigneeAgentId: "agent-9" };

  it("lets an owner see every record in the workspace", () => {
    expect(canSeeRecord({ ...viewer, userId: "someone", role: "owner" }, record, [])).toBe(true);
    expect(canSeeRecord({ ...viewer, userId: "someone", role: "admin" }, record, [])).toBe(true);
  });

  it("hides a record from a member who does not own it or hold a share", () => {
    expect(canSeeRecord(viewer, record, [])).toBe(false);
    expect(() => requireVisible(viewer, record, [])).toThrow(/not visible/);
  });

  it("shows a record the member owns, a record shared with them, and a record assigned to their agent", () => {
    expect(canSeeRecord({ ...viewer, userId: "owner-user" }, record, [])).toBe(true);
    expect(canSeeRecord(viewer, record, [{ principalType: "user", principalId: "user-1" }])).toBe(true);
    expect(canSeeRecord({ ...viewer, userId: null, agentId: "agent-9" }, record, [])).toBe(true);
  });

  it("treats an accepted partner company grant as a share of that named record", () => {
    const foreign = { companyId: "workspace-b", ownerUserId: "other", assigneeAgentId: null };
    expect(canSeeRecord({ ...viewer, role: "admin" }, foreign, [])).toBe(false);
    expect(
      canSeeRecord(viewer, foreign, [{ principalType: "company", principalId: "workspace-a" }]),
    ).toBe(true);
  });
});

describe("crm sequences", () => {
  const steps = [
    { position: 1, delayMinutes: 0, title: "Intro", body: "Say hello" },
    { position: 2, delayMinutes: 60, title: "Follow up", body: "Check in" },
  ];

  it("refuses a second running enrollment", () => {
    expect(() =>
      startEnrollment({
        companyId: "workspace-a",
        sequenceId: "seq-1",
        contactId: "contact-1",
        existing: [{ status: "running" }],
        steps,
        now: new Date("2026-09-25T12:00:00Z"),
      }),
    ).toThrow(/running enrollment/);
  });

  it("stops running enrollments when a deal is won or lost", () => {
    const stopped = stopRunningEnrollments(
      [{ id: "enr", status: "running" }, { id: "old", status: "done" }],
      "won",
    );
    expect(stopped.map((row) => row.status)).toEqual(["stopped", "done"]);
    expect(stopRunningEnrollments([{ id: "enr", status: "running" }], "open")[0]?.status).toBe("running");
  });

  it("completes a manual step only when the issue is done", () => {
    expect(canCompleteStep({ completionMode: "manual", issueStatus: "todo", sentConfirmed: true })).toBe(false);
    expect(canCompleteStep({ completionMode: "manual", issueStatus: "done", sentConfirmed: false })).toBe(true);
    expect(canCompleteStep({ completionMode: "sent", issueStatus: "todo", sentConfirmed: false })).toBe(false);
    expect(canCompleteStep({ completionMode: "sent", issueStatus: null, sentConfirmed: true })).toBe(true);
  });

  it("advances to the next step and then finishes", () => {
    const started = startEnrollment({
      companyId: "workspace-a",
      sequenceId: "seq-1",
      contactId: "contact-1",
      existing: [],
      steps,
      now: new Date("2026-09-25T12:00:00Z"),
    });
    const next = advanceEnrollment(started, steps, new Date("2026-09-25T13:00:00Z"));
    expect(next.stepPosition).toBe(2);
    expect(next.status).toBe("running");
    expect(advanceEnrollment(next, steps, new Date("2026-09-25T15:00:00Z")).status).toBe("done");
  });
});

describe("crm products", () => {
  it("creates a product with a default currency and zero amount", () => {
    const product = createProduct({ companyId: "workspace-a", name: "Website rebuild" });
    expect(product.name).toBe("Website rebuild");
    expect(product.currency).toBe("ZAR");
    expect(product.unitAmountMinor).toBe(0);
    expect(product.isActive).toBe(true);
  });

  it("rejects a blank product name", () => {
    expect(() => createProduct({ companyId: "workspace-a", name: "   " })).toThrow(/name is required/);
  });

  it("rejects a negative unit amount", () => {
    expect(() => createProduct({ companyId: "workspace-a", name: "X", unitAmountMinor: -5 })).toThrow(/non-negative/);
  });
});

describe("crm contact scoring", () => {
  const base = {
    lifecycle: "lead" as const,
    hasEmail: false,
    hasPhone: false,
    hasNextAction: false,
    activityCount: 0,
    lastActivityAt: null,
    tags: [] as string[],
    now: "2026-09-25T12:00:00Z",
  };

  it("scores a cold lead low", () => {
    const score = scoreContact(base);
    expect(score.total).toBe(10);
    expect(scoreBand(score.total)).toBe("cold");
  });

  it("scores an engaged prospect with contact details higher", () => {
    const score = scoreContact({
      ...base,
      lifecycle: "prospect",
      hasEmail: true,
      hasPhone: true,
      hasNextAction: true,
      activityCount: 4,
      lastActivityAt: "2026-09-24T12:00:00Z",
      tags: ["hot"],
    });
    expect(score.total).toBeGreaterThanOrEqual(60);
    expect(scoreBand(score.total)).toBe("hot");
    expect(score.parts.some((part) => part.label === "Priority tag")).toBe(true);
  });

  it("caps the score at 100", () => {
    const score = scoreContact({
      ...base,
      lifecycle: "customer",
      hasEmail: true,
      hasPhone: true,
      hasNextAction: true,
      activityCount: 5,
      lastActivityAt: "2026-09-25T00:00:00Z",
      tags: ["hot", "vip"],
    });
    expect(score.total).toBe(100);
  });

  it("rewards recent engagement more than old engagement", () => {
    const recent = scoreContact({ ...base, activityCount: 1, lastActivityAt: "2026-09-24T12:00:00Z" });
    const old = scoreContact({ ...base, activityCount: 1, lastActivityAt: "2026-08-01T12:00:00Z" });
    expect(recent.total).toBeGreaterThan(old.total);
  });
});

describe("crm duplicate detection and merge", () => {
  it("flags two contacts that share an email", () => {
    expect(isDuplicatePair({ emails: ["ada@northwind.test"] }, { emails: ["ADA@northwind.test"] })).toBe(true);
    expect(isDuplicatePair({ emails: ["ada@northwind.test"] }, { emails: ["grace@northwind.test"] })).toBe(false);
  });

  it("refuses to merge a contact with itself", () => {
    expect(() => assertMergeTargets("contact-1", "contact-1")).toThrow(/different contacts/);
    expect(() => assertMergeTargets("contact-1", "contact-2")).not.toThrow();
  });
});

describe("crm saved views", () => {
  it("creates a saved view with a record type", () => {
    const view = createSavedView({ companyId: "workspace-a", name: "Hot leads", recordType: "contact", filters: { lifecycle: "lead" } });
    expect(view.recordType).toBe("contact");
    expect(view.filters).toEqual({ lifecycle: "lead" });
  });

  it("rejects a blank name and an invalid record type", () => {
    expect(() => createSavedView({ companyId: "workspace-a", name: "  ", recordType: "contact" })).toThrow(/name is required/);
    expect(() => createSavedView({ companyId: "workspace-a", name: "X", recordType: "widget" })).toThrow(/contact, company, or deal/);
  });
});

describe("crm csv", () => {
  it("round-trips a CSV with quoted cells", () => {
    const csv = toCsv(["name", "emails"], [
      { name: "Ada, Lovelace", emails: "ada@northwind.test" },
      { name: "Grace", emails: "grace@northwind.test" },
    ]);
    const rows = parseCsv(csv);
    expect(rows[0]).toEqual(["name", "emails"]);
    expect(rows[1][0]).toBe("Ada, Lovelace");
    expect(rows[2][1]).toBe("grace@northwind.test");
  });

  it("escapes quotes in CSV cells", () => {
    const csv = toCsv(["name"], [{ name: 'He said "hi"' }]);
    expect(csv).toContain('"He said ""hi"""');
  });
});

describe("crm pipeline forecast", () => {
  const stages = [
    { id: "s1", name: "Discovery", kind: "open" as const, position: 0 },
    { id: "s2", name: "Proposal", kind: "open" as const, position: 1 },
    { id: "s3", name: "Won", kind: "won" as const, position: 2 },
  ];

  it("weights open deals by stage position", () => {
    const forecast = forecastPipeline({
      stages,
      deals: [
        { stageId: "s1", amountMinor: 100000, currency: "ZAR" },
        { stageId: "s2", amountMinor: 200000, currency: "ZAR" },
        { stageId: "s3", amountMinor: 500000, currency: "ZAR" },
      ],
    });
    expect(forecast.totalOpenMinor).toBe(300000);
    expect(forecast.weightedMinor).toBeGreaterThan(0);
    expect(forecast.weightedMinor).toBeLessThan(300000);
    const won = forecast.stages.find((stage) => stage.kind === "won");
    expect(won?.probability).toBe(1);
  });
});
