import { describe, expect, it } from "vitest";
import { TIER_MODULES } from "@partnersinbiz/pib-plugin-kit";
import { checkServiceStep } from "../src/done-checks.js";
import { ensureServiceStep, provisioningRequest, serviceStepContent } from "../src/service-onboarding.js";
import { serviceStepOrigin } from "../src/services.js";
import { CO, ago, boot, seed, tool, toolRaw } from "./helpers/crm.js";
import type { Route } from "./helpers/fake-db.js";
import { isServiceKey, serviceDef } from "../src/services.js";

describe("platform service (PAR-5160)", () => {
  it("is in the vocabulary, started by the Operator", () => {
    expect(isServiceKey("platform")).toBe(true);
    expect(serviceDef("platform")?.role).toBe("operator");
  });

  it("derives the modules from the tier table", () => {
    expect(TIER_MODULES.starter).toEqual(["crm", "mailbox"]);
    expect(TIER_MODULES.growth).toEqual(["crm", "mailbox", "social", "seo", "campaigns"]);
    expect(TIER_MODULES.business).toEqual(["crm", "mailbox", "social", "seo", "campaigns", "billing"]);
    const [line] = provisioningRequest({ name: "Acme", hosted: { plan: "growth", ownerEmail: "o@acme.test" } });
    expect(line).toContain("plan `growth`");
    expect(line).toContain("profile `client`");
    expect(line).toContain("o@acme.test");
    expect(line).toContain("Social media");
    expect(line).not.toContain("Billing");
  });

  it("flags a missing plan or owner instead of guessing", () => {
    const [line] = provisioningRequest({ name: "Acme", hosted: { plan: "gold", ownerEmail: null } });
    expect(line).toContain("MISSING");
  });

  it("titles the task Provision hosted company for <client>", () => {
    const content = serviceStepContent({ def: serviceDef("platform")!, client: { kind: "company", id: "c1", name: "Acme", canary: false }, prefix: null, missing: [], hosted: { plan: "business", ownerEmail: "o@acme.test" } });
    expect(content.title).toBe("Provision hosted company for Acme");
    expect(content.description).toContain("Billing");
  });

  it("does not open a platform step for a person-only client", async () => {
    const { harness } = await boot({ store: seed() });
    const result = await ensureServiceStep(harness.ctx, { companyId: CO, client: { kind: "contact", id: "thandi", name: "Thandi", lifecycle: "customer", canary: false }, service: "platform", covered: false });
    expect(result).toMatchObject({ status: "skipped" });
    expect(result.reason).toMatch(/company/);
  });

  describe("closing the step", () => {
    const issue = { id: "iss-1", companyId: CO, identifier: "PIB-9", title: "Provision", originId: serviceStepOrigin("company", "acme", "platform", "20261003"), assigneeAgentId: "op-1", createdAt: ago(60) };
    const hostedRoute = (hostedCompanyId: string | null): Route => [/hosted_company_id, hosted_plan FROM/, () => [{ hosted_company_id: hostedCompanyId, hosted_plan: "growth" }]];
    const withPlatform = () => {
      const store = seed();
      store.client_profiles = [{ id: "pr1", company_id: CO, client_kind: "company", client_ref: "acme", services: ["platform"], services_normalized_at: "2026-10-01T00:00:00Z", services_other: [], banned_words: [], human_owned: [] }];
      store.activities = [{ id: "a1", company_id: CO, record_type: "company", record_id: "acme", kind: "note", body: "x", issue_id: null, meta: null, source_key: null, created_at: ago(5) }];
      return store;
    };

    it("stays open until hostedCompanyId is written, even with proof logged", async () => {
      const { harness } = await boot({ store: withPlatform(), routes: [hostedRoute(null)] });
      const result = await checkServiceStep(harness.ctx, issue);
      expect(result.done).toBe(false);
      expect(result.missing![0]).toMatch(/hosted company id is not written/);
    });

    it("closes once hostedCompanyId is written and proof is logged", async () => {
      const { harness } = await boot({ store: withPlatform(), routes: [hostedRoute("hc-1")] });
      expect(await checkServiceStep(harness.ctx, issue)).toEqual({ done: true });
    });
  });

  describe("update-company", () => {
    const route = (id: string | null): Route => [/hosted_company_id, hosted_plan FROM/, () => [{ hosted_company_id: id, hosted_plan: null }]];

    it("refuses a plan that is not a tier", async () => {
      const { harness } = await boot({ store: seed(), routes: [route(null)] });
      const result = await toolRaw(harness, "update-company", { companyRecordId: "acme", hostedPlan: "gold" });
      expect(result.error).toMatch(/hostedPlan must be one of starter, growth, business/);
    });

    it("refuses to replace a hosted company id that is already set, but accepts the same id", async () => {
      const { harness } = await boot({ store: seed(), routes: [route("hc-1")] });
      expect((await toolRaw(harness, "update-company", { companyRecordId: "acme", hostedCompanyId: "hc-2" })).error).toMatch(/already has a hosted company/);
      await expect(tool(harness, "update-company", { companyRecordId: "acme", hostedCompanyId: "hc-1" })).resolves.toBeTruthy();
    });
  });
});
