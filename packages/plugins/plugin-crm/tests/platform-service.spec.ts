import { describe, expect, it } from "vitest";
import { TIER_MODULES } from "@partnersinbiz/pib-plugin-kit";
import { provisioningRequest, serviceStepContent } from "../src/service-onboarding.js";
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
});
