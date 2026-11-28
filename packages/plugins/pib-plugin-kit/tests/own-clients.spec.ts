/** Stage B2 (PAR-12582): the limit a handler reads from the guard's check, and whether a client is one of his companies. */
import { describe, expect, it } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { isOwnClient, ownCompaniesOf, type AccessCheck } from "../src/index.js";

const caller = { type: "user" as const, userId: "u1", agentId: null, runId: null };
const check = (decision: AccessCheck["decision"]): AccessCheck => ({ mode: "enforce", caller, decision });

/** A CRM copy with two contacts; any other query fails the test. */
function copy(): { ctx: PluginContext; queries: unknown[][] } {
  const contacts: Record<string, string[]> = { jo: ["acme"], zed: ["other", "beta"] };
  const queries: unknown[][] = [];
  const ctx = {
    db: {
      query: async (sql: string, params: unknown[]) => {
        queries.push(params);
        expect(sql).toMatch(/FROM ns\.crm_contacts WHERE company_id = \$1 AND id = \$2 AND deleted = false/);
        const ids = params[0] === "c1" ? contacts[params[1] as string] : undefined;
        return ids ? [{ account_ids: ids }] : [];
      },
    },
  } as unknown as PluginContext;
  return { ctx, queries };
}

describe("ownCompaniesOf", () => {
  it("is null (no limit) without a check, for scope all, and only a linked decision limits", () => {
    expect(ownCompaniesOf(undefined)).toBeNull();
    expect(ownCompaniesOf(null)).toBeNull();
    expect(ownCompaniesOf(check({ allowed: true, scope: "all" }))).toBeNull();
    expect([...ownCompaniesOf(check({ allowed: true, scope: "linked", companyIds: ["a", "b"] }))!]).toEqual(["a", "b"]);
    expect(ownCompaniesOf(check({ allowed: true, scope: "linked", companyIds: [] }))!.size).toBe(0);
  });
});

describe("isOwnClient", () => {
  const mine = new Set(["acme", "beta"]);
  it("a company is his by its id; own work never is; an empty list opens nothing", async () => {
    const { ctx, queries } = copy();
    expect(await isOwnClient(ctx, "ns", "c1", mine, { kind: "company", id: "acme" })).toBe(true);
    expect(await isOwnClient(ctx, "ns", "c1", mine, { kind: "company", id: "other" })).toBe(false);
    expect(await isOwnClient(ctx, "ns", "c1", mine, null)).toBe(false);
    expect(await isOwnClient(ctx, "ns", "c1", new Set(), { kind: "contact", id: "jo" })).toBe(false);
    expect(queries).toEqual([]);
  });

  it("a contact is his when it belongs to one of his companies in the copy; an unknown contact or another workspace's is not", async () => {
    const { ctx } = copy();
    expect(await isOwnClient(ctx, "ns", "c1", mine, { kind: "contact", id: "jo" })).toBe(true);
    expect(await isOwnClient(ctx, "ns", "c1", mine, { kind: "contact", id: "zed" })).toBe(true);
    expect(await isOwnClient(ctx, "ns", "c1", new Set(["acme"]), { kind: "contact", id: "zed" })).toBe(false);
    expect(await isOwnClient(ctx, "ns", "c1", mine, { kind: "contact", id: "nobody" })).toBe(false);
    expect(await isOwnClient(ctx, "ns", "c2", mine, { kind: "contact", id: "jo" })).toBe(false);
  });
});
