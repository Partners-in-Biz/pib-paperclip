import { describe, expect, it } from "vitest";
import { createPibOnlySkillSyncer, isParCompany, syncAllCompanies } from "../src/index.js";
import { fakeCtx } from "./helpers/fake-ctx.js";

const SKILLS = [{ skillKey: "pib-seo-own", markdown: "own-company facts" }];
const COMPANIES = { par: { issuePrefix: "PAR" }, client: { issuePrefix: "ACM" } };

describe("isParCompany", () => {
  it("is true for the PAR prefix only", async () => {
    const { ctx } = fakeCtx({ companies: COMPANIES });
    expect(await isParCompany(ctx, "par")).toBe(true);
    expect(await isParCompany(ctx, "client")).toBe(false);
    expect(await isParCompany(ctx, "unknown")).toBe(false);
  });

  it("is false when the lookup throws", async () => {
    const { ctx } = fakeCtx({ companies: COMPANIES });
    ctx.companies.get = async () => {
      throw new Error("host busy");
    };
    expect(await isParCompany(ctx, "par")).toBe(false);
  });
});

describe("createPibOnlySkillSyncer", () => {
  it("syncs PAR through ensure, force and check", async () => {
    const fake = fakeCtx({ companies: COMPANIES });
    const syncer = createPibOnlySkillSyncer(fake.ctx, SKILLS);
    expect((await syncer.ensure("par")).map((r) => r.action)).toEqual(["reset"]);
    expect((await syncer.force("par")).map((r) => r.action)).toEqual(["reset"]);
    expect((await syncer.check("par")).map((r) => r.action)).toEqual(["reconcile"]);
    expect(fake.resets).toEqual([
      { key: "pib-seo-own", companyId: "par" },
      { key: "pib-seo-own", companyId: "par" },
    ]);
  });

  it("does nothing for another company, and does not remember it", async () => {
    const fake = fakeCtx({ companies: COMPANIES });
    const syncer = createPibOnlySkillSyncer(fake.ctx, SKILLS);
    expect(await syncer.ensure("client")).toEqual([]);
    expect(await syncer.force("client")).toEqual([]);
    expect(await syncer.check("client")).toEqual([]);
    expect(fake.resets).toEqual([]);
    expect(fake.state.size).toBe(0);
  });

  it("does nothing when the company lookup fails", async () => {
    const fake = fakeCtx({ companies: COMPANIES });
    fake.ctx.companies.get = async () => {
      throw new Error("host busy");
    };
    const syncer = createPibOnlySkillSyncer(fake.ctx, SKILLS);
    expect(await syncer.ensure("par")).toEqual([]);
    expect(await syncer.force("par")).toEqual([]);
    expect(await syncer.check("par")).toEqual([]);
    expect(fake.resets).toEqual([]);
  });

  it("the sweep syncs PAR and skips every other company", async () => {
    const fake = fakeCtx({ companies: COMPANIES });
    const syncer = createPibOnlySkillSyncer(fake.ctx, SKILLS);
    const sweep = await syncAllCompanies(fake.ctx, syncer, { isEnabled: syncer.isEnabled });
    const status = Object.fromEntries(sweep.outcomes.map((o) => [o.companyId, o.status]));
    expect(status).toEqual({ par: "synced", client: "skipped" });
    expect(fake.resets).toEqual([{ key: "pib-seo-own", companyId: "par" }]);
  });
});
