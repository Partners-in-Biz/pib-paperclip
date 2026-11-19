import { describe, expect, it } from "vitest";
import { decideAgentWakeAuthority } from "./agent-wake-authority.js";

const company = "c1";
// coo -> lead -> mac ; sysadmin -> coo
const reportsTo: Record<string, string | null> = { coo: null, lead: "coo", mac: "lead", sysadmin: "coo", peer: "coo" };
const chainOf = async (id: string) => {
  const chain: { id: string }[] = [];
  let cur = reportsTo[id];
  while (cur) { chain.push({ id: cur }); cur = reportsTo[cur]; }
  return chain;
};
const decide = (actor: string, target: string, canConfigure = false, actorCompany = company) =>
  decideAgentWakeAuthority({
    actorAgentId: actor,
    actorCompanyId: actorCompany,
    target: { id: target, companyId: company },
    getChainOfCommand: chainOf,
    canConfigureTarget: async () => canConfigure,
  });

describe("decideAgentWakeAuthority", () => {
  it("lets an agent wake itself", async () => {
    expect(await decide("mac", "mac")).toEqual({ allowed: true, reason: "self" });
  });
  it("lets a direct manager wake its report", async () => {
    expect(await decide("lead", "mac")).toEqual({ allowed: true, reason: "manager_chain" });
  });
  it("lets the top of the chain wake anyone below it", async () => {
    expect(await decide("coo", "mac")).toEqual({ allowed: true, reason: "manager_chain" });
  });
  it("denies a report waking its manager or a peer without a grant", async () => {
    expect((await decide("mac", "lead")).allowed).toBe(false);
    expect((await decide("sysadmin", "mac")).reason).toBe("deny_not_manager");
  });
  it("lets an agent with agents:configure wake outside its chain", async () => {
    expect(await decide("sysadmin", "mac", true)).toEqual({ allowed: true, reason: "configure_grant" });
  });
  it("never crosses companies, even with a grant", async () => {
    expect(await decide("coo", "mac", true, "other")).toEqual({ allowed: false, reason: "deny_company_boundary" });
  });
});
