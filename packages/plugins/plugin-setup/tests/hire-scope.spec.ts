import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { allModulesOn } from "../src/modules.js";
import { isOwnerCompany, startTemplateHire, templateDraft, templatesForOps } from "../src/new-company.js";
import { loadPack, offeredTemplates } from "../src/templates.js";
import { selectedTemplates } from "../src/bootstrap-runner.js";
import { fakeCtx } from "./helpers/fake-ctx.js";

const A = "pib-company";
const B = "client-company";
const COMPANIES = { [A]: { name: "Partners in Biz", issuePrefix: "PIB" }, [B]: { name: "Client Corp", issuePrefix: "CLI" } };
const PIB = "pib-only";
const ownerCtx = () => fakeCtx({ companies: COMPANIES, savedConfigs: { [A]: { ownerCompany: true } } });
const clientCtx = () => fakeCtx({ companies: COMPANIES, savedConfigs: { [B]: { ownerCompany: false } } });
const keysFor = async (ctx: ReturnType<typeof fakeCtx>["ctx"], companyId: string) =>
  (await templatesForOps(ctx, { companyId, key: "ceo", agents: [] })).templates.map((t: { key: string }) => t.key);

// The shipped pack has no pib template yet: remember what it ships, then add one (a defaultOn copy of the Developer) for the tests.
const SHIPPED = loadPack().templates.map((t) => ({ key: t.key, scope: t.scope }));
beforeAll(() => {
  const developer = loadPack().templates.find((t) => t.key === "developer")!;
  loadPack().templates.push({ ...developer, key: PIB, name: "PiB Only", scope: "pib", defaultOn: true });
});
afterAll(() => {
  const templates = loadPack().templates;
  templates.splice(templates.findIndex((t) => t.key === PIB), 1);
});

describe("hire scope: a pib template is offered to the PiB company only", () => {
  it("a client company's hire list is the shipped pack minus its pib templates (delivery-lead today)", async () => {
    const shippedNonPib = SHIPPED.filter((t) => t.scope !== "pib").map((t) => t.key);
    const clientKeys = await keysFor(clientCtx().ctx, B);
    expect(clientKeys).toEqual(shippedNonPib);
    expect(clientKeys).not.toContain("delivery-lead");
    const ownerKeys = await keysFor(ownerCtx().ctx, A);
    expect(ownerKeys).toContain("delivery-lead");
  });

  it("templatesForOps leaves a pib template out of a client company and lists it for the owner company", async () => {
    const client = await templatesForOps(clientCtx().ctx, { companyId: B, key: "ceo", agents: [] });
    const owner = await templatesForOps(ownerCtx().ctx, { companyId: A, key: "ceo", agents: [] });
    expect(client.ownerCompany).toBe(false);
    expect(client.templates.map((t: { key: string }) => t.key)).not.toContain(PIB);
    expect(owner.ownerCompany).toBe(true);
    expect(owner.templates.map((t: { key: string }) => t.key)).toContain(PIB);
    expect(await keysFor(ownerCtx().ctx, A)).toEqual(expect.arrayContaining(SHIPPED.map((t) => t.key)));
  });

  it("selectedTemplates drops a pib template from the defaults and from an explicit key list for a client company", () => {
    const modules = allModulesOn();
    expect(selectedTemplates({}, modules, false).map((t) => t.key)).not.toContain(PIB);
    expect(selectedTemplates({}, modules, true).map((t) => t.key)).toContain(PIB);
    expect(selectedTemplates({ templates: ["developer", PIB] }, modules, false).map((t) => t.key)).toEqual(["developer"]);
    expect(selectedTemplates({ templates: ["developer", PIB] }, modules, true).map((t) => t.key)).toEqual(["developer", PIB]);
  });

  it("setup.template-draft and the hire refuse a pib template in a client company and open no issue", async () => {
    const client = clientCtx();
    await expect(templateDraft(client.ctx, { companyId: B, key: PIB, agents: [] })).rejects.toThrow(/Partners in Biz company only/);
    await expect(startTemplateHire(client.ctx, { companyId: B, key: PIB, agents: [], userId: "user-1", assigneeUserId: "user-1" })).rejects.toThrow(/Partners in Biz company only/);
    expect(client.issues.size).toBe(0);
  });

  it("the owner company can draft and hire the pib template", async () => {
    const owner = ownerCtx();
    expect(await templateDraft(owner.ctx, { companyId: A, key: PIB, agents: [] })).toHaveProperty("key", PIB);
    await startTemplateHire(owner.ctx, { companyId: A, key: PIB, agents: [], userId: "user-1", assigneeUserId: "user-1" });
    expect(owner.issues.size).toBe(1);
  });

  it("isOwnerCompany reads the ownerCompany setting and fails closed", async () => {
    expect(await isOwnerCompany(ownerCtx().ctx, A)).toBe(true);
    expect(await isOwnerCompany(clientCtx().ctx, B)).toBe(false);
    expect(await isOwnerCompany(fakeCtx({ companies: COMPANIES }).ctx, A)).toBe(false);
  });

  it("offeredTemplates keeps generic templates (scope absent counts as generic) and gates pib on the owner flag", () => {
    const list = [{ key: "g1" }, { key: "g2", scope: "generic" as const }, { key: "p", scope: "pib" as const }];
    expect(offeredTemplates(list, false).map((t) => t.key)).toEqual(["g1", "g2"]);
    expect(offeredTemplates(list, true).map((t) => t.key)).toEqual(["g1", "g2", "p"]);
  });
});
