import { describe, expect, it } from "vitest";
import { newClientChecklist, type NewClientState } from "../src/new-client.js";
import { EMPTY_PROFILE } from "../src/store.js";
import { BOARD, CO, boot, seed, tool, toolRaw, type Harness } from "./helpers/crm.js";
import type { Store } from "./helpers/fake-db.js";

const state = (extra: Partial<NewClientState> = {}): NewClientState => ({
  client: { kind: "company", id: "acme", name: "Acme Plumbing", lifecycle: "prospect" },
  profile: null,
  linkedProjects: [],
  suggestedProjects: [],
  sites: 0,
  leadForms: 0,
  steps: [],
  ...extra,
});
const byKey = (checklist: ReturnType<typeof newClientChecklist>, key: string) => checklist.find((step) => step.key === key)!;
const seedProjects = (harness: Harness, repo = false) =>
  harness.seed({ projects: [{ id: "proj-acme", companyId: CO, name: "Acme site", ...(repo ? { primaryWorkspace: { repoUrl: "https://github.com/Partners-in-Biz/acme" } } : {}) } as never, { id: "proj-other", companyId: CO, name: "Globex app" } as never] });

describe("the new-client checklist", () => {
  it("starts with what the CRM knows is missing, in the order to do it, each with who does it", () => {
    const checklist = newClientChecklist(state());
    expect(checklist.map((step) => step.key)).toEqual(["crm-record", "profile", "services", "project", "repo", "branch-policy", "agent-guide", "brand-kit", "grants", "billing"]);
    expect(byKey(checklist, "crm-record")).toMatchObject({ state: "done", owner: "Account Manager" });
    expect(byKey(checklist, "profile")).toMatchObject({ state: "todo", owner: "Account Manager" });
    expect(byKey(checklist, "profile").detail).toMatch(/Missing: brandVoice, audience, services, website, bookingLink, bannedWords, toneNotes/);
    expect(byKey(checklist, "project")).toMatchObject({ state: "todo", owner: "Delivery Lead" });
    expect(byKey(checklist, "project").how).toContain("new-client-project.py");
    expect(byKey(checklist, "project").how).toContain("crm.link-client-project");
    expect(byKey(checklist, "repo").state).toBe("waits");
    // What the CRM cannot see it does not claim.
    for (const key of ["branch-policy", "agent-guide", "grants", "billing"]) expect(byKey(checklist, key).state).toBe("unknown");
    expect(byKey(checklist, "branch-policy").how).toMatch(/development/);
    expect(byKey(checklist, "branch-policy").how).toMatch(/main only changes with Peet's approval/);
    expect(byKey(checklist, "grants").how).toMatch(/ONE ask|One ask/i);
  });

  it("marks done what the records show: a profile with all seven fields, services, a linked project with a repo", () => {
    const profile = { ...EMPTY_PROFILE, brandVoice: "Warm", audience: "Homeowners", services: ["seo"], website: "https://acme.co.za", bookingLink: "https://acme.co.za/book", bannedWords: ["cheap"], toneNotes: "Plain", logoKey: "social/co-1/logo.png", primaryColor: "#112233", fonts: ["Inter"], toneExamples: ["Hi"] };
    const checklist = newClientChecklist(state({ profile: { ...profile, id: "p", companyId: CO, clientKind: "company", clientRef: "acme", humanOwned: [], updatedBy: null, updatedAt: null, servicesNormalizedAt: "x" }, linkedProjects: [{ projectId: "p1", name: "Acme site", repoUrl: "https://github.com/x/acme", archived: false }], sites: 1 }));
    for (const key of ["crm-record", "profile", "services", "project", "repo", "brand-kit", "site"]) expect(byKey(checklist, key).state, key).toBe("done");
  });

  it("a linked project with no git workspace (or an archived one) is not a repo", () => {
    expect(byKey(newClientChecklist(state({ linkedProjects: [{ projectId: "p1", name: "Acme", repoUrl: null, archived: false }] })), "repo").state).toBe("todo");
    expect(byKey(newClientChecklist(state({ linkedProjects: [{ projectId: "p1", name: "Acme", repoUrl: "https://github.com/x/acme", archived: true }] })), "repo").state).toBe("todo");
  });

  it("asks for a website and a lead form only when the services need them", () => {
    const profile = (services: string[]) => ({ ...EMPTY_PROFILE, services, id: "p", companyId: CO, clientKind: "company" as const, clientRef: "acme", humanOwned: [], updatedBy: null, updatedAt: null, servicesNormalizedAt: "x" });
    expect(byKey(newClientChecklist(state({ profile: profile(["bookkeeping"]) })), "site")).toBeUndefined();
    expect(byKey(newClientChecklist(state({ profile: profile(["bookkeeping"]) })), "lead-form")).toBeUndefined();
    const needs = newClientChecklist(state({ profile: profile(["seo", "lead-capture"]) }));
    expect(byKey(needs, "site")).toMatchObject({ state: "todo", owner: "Account Manager" });
    expect(byKey(needs, "lead-form")).toMatchObject({ state: "todo" });
    const done = newClientChecklist(state({ profile: profile(["seo", "lead-capture"]), sites: 1, leadForms: 1 }));
    expect(byKey(done, "site").state).toBe("done");
    expect(byKey(done, "lead-form").state).toBe("done");
  });

  it("one line per service: waits for a prospect, todo for a customer, done once started or covered", () => {
    const profile = { ...EMPTY_PROFILE, services: ["seo", "social", "website"], id: "p", companyId: CO, clientKind: "company" as const, clientRef: "acme", humanOwned: [], updatedBy: null, updatedAt: null, servicesNormalizedAt: "x" };
    const steps = [
      { id: "1", companyId: CO, clientKind: "company" as const, clientRef: "acme", service: "seo", status: "started" as const, issueId: "i1", note: null, openedAt: null, completedAt: null },
      { id: "2", companyId: CO, clientKind: "company" as const, clientRef: "acme", service: "social", status: "open" as const, issueId: "i2", note: null, openedAt: null, completedAt: null },
    ];
    const prospect = newClientChecklist(state({ profile, steps }));
    expect(byKey(prospect, "service:seo").state).toBe("done");
    expect(byKey(prospect, "service:social").state).toBe("waits");
    const customer = newClientChecklist(state({ client: { kind: "company", id: "acme", name: "Acme", lifecycle: "customer" }, profile, steps }));
    expect(byKey(customer, "service:social")).toMatchObject({ state: "todo", how: "The step is issue i2." });
    expect(byKey(customer, "service:website")).toMatchObject({ state: "todo", owner: "operator" });
    expect(byKey(customer, "service:seo").owner).toBe("seo-specialist");
  });

  it("suggests the projects that look like the client's", () => {
    const text = byKey(newClientChecklist(state({ suggestedProjects: [{ projectId: "proj-acme", name: "Acme site" }] })), "project").detail;
    expect(text).toContain("Acme site (proj-acme)");
  });
});

describe("start-new-client", () => {
  it("shows the checklist for a client with nothing set up, and suggests the project that matches by name", async () => {
    const { harness } = await boot();
    seedProjects(harness);
    const result = await tool<Record<string, any>>(harness, "start-new-client", { client: "company:acme" });
    expect(result).toMatchObject({ client: "company:acme", name: "Acme Plumbing", lifecycle: "prospect", link: "/PIB/crm?client=company%3Aacme" });
    expect(result.project).toBeUndefined();
    const project = result.checklist.find((step: { key: string }) => step.key === "project");
    expect(project).toMatchObject({ state: "todo" });
    expect(project.detail).toContain("Acme site (proj-acme)");
    expect(project.detail).not.toContain("Globex app");
    expect(result.remaining).toContain("A Paperclip project for the client's work");
    expect(result.remaining).not.toContain("The client is in the CRM");
    expect(result.next).toMatch(/still to do/);
  });

  it("links the project it is given, and the project step turns done (and the repo step follows the workspace)", async () => {
    const { harness, store } = await boot();
    seedProjects(harness);
    const first = await tool<Record<string, any>>(harness, "start-new-client", { client: "company:acme", projectId: "proj-acme" });
    expect(first.project).toEqual({ projectId: "proj-acme", name: "Acme site", linked: true, alreadyLinked: false });
    expect(store.client_projects).toEqual([expect.objectContaining({ client_kind: "company", client_ref: "acme", project_id: "proj-acme" })]);
    const step = (key: string) => first.checklist.find((row: { key: string }) => row.key === key);
    expect(step("project").state).toBe("done");
    // The seeded project has no workspace: the repo step says so.
    expect(step("repo").state).toBe("todo");
    const again = await tool<Record<string, any>>(harness, "start-new-client", { client: "company:acme", projectId: "proj-acme" });
    expect(again.project).toMatchObject({ linked: false, alreadyLinked: true });
    expect(store.client_projects).toHaveLength(1);
  });

  it("the repo step is done when the project has a git workspace", async () => {
    const { harness } = await boot();
    seedProjects(harness, true);
    const result = await tool<Record<string, any>>(harness, "start-new-client", { client: "company:acme", projectId: "proj-acme" });
    expect(result.checklist.find((row: { key: string }) => row.key === "repo").state).toBe("done");
  });

  it("refuses a project that belongs to another client, naming it, and an unknown project or client", async () => {
    const { harness } = await boot();
    seedProjects(harness);
    await tool(harness, "start-new-client", { client: "company:acme", projectId: "proj-acme" });
    expect((await toolRaw(harness, "start-new-client", { client: "company:globex", projectId: "proj-acme" })).error).toMatch(/already belongs to company:acme/);
    expect((await toolRaw(harness, "start-new-client", { client: "company:acme", projectId: "nope" })).error).toMatch(/Project nope was not found/);
    expect((await toolRaw(harness, "start-new-client", { client: "company:foreign" })).error).toMatch(/not found or is not visible/);
    expect((await toolRaw(harness, "start-new-client", { client: "acme" })).error).toMatch(/company:<id> or contact:<id>/);
  });

  it("sets the services when listed, and a customer's checklist shows each service's step", async () => {
    const store: Store = seed();
    store.companies!.find((row) => row.id === "acme")!.lifecycle = "customer";
    const { harness } = await boot({ store });
    const result = await tool<Record<string, any>>(harness, "start-new-client", { client: "company:acme", services: ["SEO retainer", "Lead generation"] });
    expect(result.servicesSet).toEqual(["seo", "lead-capture"]);
    const keys = result.checklist.map((row: { key: string }) => row.key);
    expect(keys).toEqual(expect.arrayContaining(["site", "lead-form", "service:seo", "service:lead-capture"]));
    // The services opened their steps at once for a customer.
    const seo = result.checklist.find((row: { key: string }) => row.key === "service:seo");
    expect(seo).toMatchObject({ state: "todo", owner: "seo-specialist" });
    expect(seo.how).toMatch(/^The step is issue /);
  });

  it("the lead form step turns done once the form is made, and the site step once the site is saved", async () => {
    const store: Store = seed();
    const { harness } = await boot({ store });
    await tool(harness, "update-client-profile", { client: "company:acme", services: ["lead-capture"] });
    let result = await tool<Record<string, any>>(harness, "start-new-client", { client: "company:acme" });
    expect(result.checklist.find((row: { key: string }) => row.key === "lead-form").state).toBe("todo");
    await tool(harness, "create-lead-endpoint", { client: "company:acme" });
    await tool(harness, "save-client-site", { client: "company:acme", url: "https://www.acme.co.za", platform: "nextjs" });
    result = await tool<Record<string, any>>(harness, "start-new-client", { client: "company:acme" });
    expect(result.checklist.find((row: { key: string }) => row.key === "lead-form").state).toBe("done");
    expect(result.checklist.find((row: { key: string }) => row.key === "site").state).toBe("done");
    // A form that was switched off for good does not count.
    await harness.performAction("crm.update-lead-source", { sourceId: store.lead_sources![0]!.id, status: "revoked" }, { companyId: CO, actor: BOARD });
    result = await tool<Record<string, any>>(harness, "start-new-client", { client: "company:acme" });
    expect(result.checklist.find((row: { key: string }) => row.key === "lead-form").state).toBe("todo");
  });

  it("works for a sole trader (a contact that is a client)", async () => {
    const { harness } = await boot();
    const result = await tool<Record<string, any>>(harness, "start-new-client", { client: "contact:solo" });
    expect(result).toMatchObject({ client: "contact:solo", name: "Sipho Solo", lifecycle: "customer" });
  });
});

describe("the board actions the ops script calls", () => {
  it("crm.link-client-project: the contract of new-client-project.py, the same answer as the tool", async () => {
    const { harness, store } = await boot();
    seedProjects(harness);
    const linked = await harness.performAction<Record<string, any>>("crm.link-client-project", { client: "company:acme", projectId: "proj-acme" }, { companyId: CO, actor: BOARD });
    expect(linked).toEqual({ projectId: "proj-acme", name: "Acme site", client: "company:acme", linked: true });
    const again = await harness.performAction<Record<string, any>>("crm.link-client-project", { client: "company:acme", projectId: "proj-acme" }, { companyId: CO, actor: BOARD });
    expect(again).toEqual({ projectId: "proj-acme", name: "Acme site", client: "company:acme", alreadyLinked: true });
    expect(store.client_projects).toHaveLength(1);
    // The tool gives the same answer shape.
    const viaTool = await tool<Record<string, any>>(harness, "link-client-project", { client: "company:acme", projectId: "proj-acme" });
    expect(viaTool).toEqual(again);
    await expect(harness.performAction("crm.link-client-project", { client: "company:globex", projectId: "proj-acme" }, { companyId: CO, actor: BOARD })).rejects.toThrow(/already belongs to company:acme/);
  });

  it("crm.find-records finds the client by name so the script can resolve it without a person", async () => {
    const { harness } = await boot();
    const found = await harness.performAction<Record<string, any>>("crm.find-records", { query: "acme plumbing", kind: "company" }, { companyId: CO, actor: BOARD });
    expect(found.results[0]).toMatchObject({ ref: "company:acme", name: "Acme Plumbing" });
  });

  it("crm.start-new-client is the same checklist from the board", async () => {
    const { harness } = await boot();
    seedProjects(harness);
    const result = await harness.performAction<Record<string, any>>("crm.start-new-client", { client: "company:acme", projectId: "proj-acme" }, { companyId: CO, actor: BOARD });
    expect(result.project).toMatchObject({ linked: true });
    expect(result.checklist.length).toBeGreaterThan(8);
  });
});
