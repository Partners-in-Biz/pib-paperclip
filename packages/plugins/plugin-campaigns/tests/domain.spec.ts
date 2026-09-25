import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { NAMESPACE } from "../src/namespace.js";
import {
  advanceEnrollment,
  assertCanLaunch,
  assertCanPause,
  assertCanRequestApproval,
  assertEventType,
  assertVariant,
  createCampaignTemplate,
  createCampaign,
  matchesAudience,
  startEnrollment,
  stepIssueCopy,
} from "../src/domain.js";

describe("campaigns schema", () => {
  it("keeps the host namespace for partnersinbiz.campaigns", () => {
    expect(NAMESPACE).toBe("plugin_campaigns_d355219713");
    const sql = readFileSync(new URL("../migrations/001_campaigns.sql", import.meta.url), "utf8");
    for (const table of ["campaigns", "campaign_steps", "campaign_enrollments"]) {
      expect(sql).toContain(`CREATE TABLE ${NAMESPACE}.${table}`);
    }
    expect(sql).toContain("WHERE status = 'running'");
  });
});

describe("campaigns", () => {
  it("creates a draft campaign with a valid from local part", () => {
    const campaign = createCampaign({ companyId: "workspace-a", name: "Q3 Launch", fromLocal: "campaigns", audienceTags: ["hot", "prospect"] });
    expect(campaign.status).toBe("draft");
    expect(campaign.fromLocal).toBe("campaigns");
    expect(campaign.audienceTags).toEqual(["hot", "prospect"]);
  });

  it("rejects a blank name and an invalid from local part", () => {
    expect(() => createCampaign({ companyId: "workspace-a", name: "  " })).toThrow(/name is required/);
    expect(() => createCampaign({ companyId: "workspace-a", name: "X", fromLocal: "bad local!" })).toThrow(/local part/);
  });

  it("enforces the status lifecycle", () => {
    expect(() => assertCanLaunch("active")).toThrow(/draft or paused/);
    expect(() => assertCanPause("draft")).toThrow(/active or scheduled/);
  });

  it("matches audience by tag, and everyone when no tags are set", () => {
    expect(matchesAudience(["hot", "vip"], ["hot"])).toBe(true);
    expect(matchesAudience(["cold"], ["hot"])).toBe(false);
    expect(matchesAudience(["anything"], [])).toBe(true);
  });
});

describe("campaign enrollments", () => {
  const steps = [
    { position: 1, delayDays: 0, subject: "Welcome", body: "Hi", htmlBody: null, variant: "a" as const },
    { position: 2, delayDays: 3, subject: "Follow up", body: "Check in", htmlBody: null, variant: "a" as const },
  ];

  it("refuses a second running enrollment", () => {
    expect(() =>
      startEnrollment({
        companyId: "workspace-a",
        campaignId: "camp-1",
        contactId: "contact-1",
        existing: [{ status: "running" }],
        steps,
        now: new Date("2026-09-25T12:00:00Z"),
      }),
    ).toThrow(/running enrollment/);
  });

  it("advances to the next step and then finishes", () => {
    const started = startEnrollment({
      companyId: "workspace-a",
      campaignId: "camp-1",
      contactId: "contact-1",
      existing: [],
      steps,
      now: new Date("2026-09-25T12:00:00Z"),
    });
    expect(started.stepPosition).toBe(1);
    const next = advanceEnrollment(started, steps, new Date("2026-09-28T12:00:00Z"));
    expect(next.stepPosition).toBe(2);
    expect(advanceEnrollment(next, steps, new Date("2026-10-01T12:00:00Z")).status).toBe("done");
  });

  it("builds an issue title from the step subject and contact name", () => {
    const copy = stepIssueCopy("Ada Lovelace", steps[0]);
    expect(copy.title).toBe("Welcome: Ada Lovelace");
  });
});

describe("campaign approval", () => {
  it("only a draft can be sent for approval", () => {
    expect(() => assertCanRequestApproval("draft")).not.toThrow();
    expect(() => assertCanRequestApproval("active")).toThrow(/draft/);
  });
});

describe("campaign ab variants", () => {
  it("accepts only a or b", () => {
    expect(assertVariant("a")).toBe("a");
    expect(assertVariant("b")).toBe("b");
    expect(() => assertVariant("c")).toThrow(/a or b/);
  });
});

describe("campaign step events", () => {
  it("accepts only open or click", () => {
    expect(assertEventType("open")).toBe("open");
    expect(assertEventType("click")).toBe("click");
    expect(() => assertEventType("bounce")).toThrow(/open or click/);
  });
});

describe("campaign templates", () => {
  it("creates a template with steps", () => {
    const template = createCampaignTemplate({
      companyId: "workspace-a",
      name: "Welcome",
      steps: [{ subject: "Hi", delayDays: 0 }, { subject: "Follow up", delayDays: 3 }],
    });
    expect(template.steps).toHaveLength(2);
    expect(template.steps[1].delayDays).toBe(3);
  });

  it("rejects a blank name and a step without a subject", () => {
    expect(() => createCampaignTemplate({ companyId: "workspace-a", name: "  " })).toThrow(/name is required/);
    expect(() => createCampaignTemplate({ companyId: "workspace-a", name: "X", steps: [{ subject: "  " }] })).toThrow(/needs a subject/);
  });
});
