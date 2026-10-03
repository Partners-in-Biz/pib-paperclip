import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { TEAM_ROLES } from "@partnersinbiz/pib-plugin-kit";
import { checkServiceStep, closeStands } from "../src/done-checks.js";
import { NAMESPACE } from "../src/namespace.js";
import { MAX_NEW_STEPS_PER_RUN, onServiceStepIssue, runServicesCheck, serviceStepContent, stepsView } from "../src/service-onboarding.js";
import { CLIENT_SERVICES_EVENT, diffServices, isServiceKey, normalizeServices, parseServiceStep, SERVICE_KEYS, SERVICES, serviceDef, serviceLabel, serviceStepOrigin } from "../src/services.js";
import { BOARD, CO, ago, boot as bootCrm, crmIssues, seed, setRoles, tool, toolRaw, type Harness } from "./helpers/crm.js";
import type { Route, Row, Store } from "./helpers/fake-db.js";
import { splitSqlStatements, validateMigrationStatement } from "./helpers/sql-guard.js";

const COCKPIT_ONBOARDING = "plugin:partnersinbiz.cockpit:onboarding";

/** The Cockpit's onboarding issue is read from the issue table (a plugin may not list another plugin's issues through the host). */
const ONBOARDING_ROUTE: Route = [
  /public\.issues i WHERE i\.company_id::text = \$1 AND i\.origin_kind = \$2 AND i\.origin_id = \$3/,
  (p, s) => (s.issues ?? []).filter((row) => row.company_id === p[0] && row.origin_kind === p[1] && row.origin_id === p[2]).slice(0, 1),
];
const boot = (options: Parameters<typeof bootCrm>[0] = {}) => bootCrm({ ...options, routes: [ONBOARDING_ROUTE, ...(options.routes ?? [])] });
const cockpitOnboarding = (store: Store, status: string, client = "company:acme") => {
  store.issues = [...(store.issues ?? []), { id: "cockpit-1", company_id: CO, origin_kind: COCKPIT_ONBOARDING, origin_id: `cockpit:onboarding:${client}`, status }];
};

describe("the services list", () => {
  it("holds the services the audit named, each owned by a real team role, with steps and proof", () => {
    for (const key of ["seo", "social", "campaigns", "reporting", "lead-capture", "website", "development", "bookkeeping"]) expect(SERVICE_KEYS).toContain(key);
    expect(new Set(SERVICE_KEYS).size).toBe(SERVICE_KEYS.length);
    expect(new Set(SERVICES.map((service) => service.label)).size).toBe(SERVICES.length);
    const roles = new Set(TEAM_ROLES.map((role) => role.key as string));
    for (const service of SERVICES) {
      expect(roles.has(service.role), `${service.key} role`).toBe(true);
      expect(service.start.length, `${service.key} start`).toBeGreaterThan(0);
      expect(service.evidence.length, `${service.key} evidence`).toBeGreaterThan(5);
    }
    expect(isServiceKey("seo")).toBe(true);
    expect(isServiceKey("SEO retainer")).toBe(false);
    expect(isServiceKey(undefined)).toBe(false);
    expect(serviceDef("nope")).toBeNull();
    expect(serviceLabel("seo")).toBe("SEO");
    expect(serviceLabel("unknown-thing")).toBe("unknown-thing");
  });

  it("maps what people and older rows wrote, and keeps what it cannot map", () => {
    const table: Array<[string[], string[], string[]]> = [
      [["SEO retainer"], ["seo"], []],
      [["Social media management"], ["social"], []],
      [["Facebook ads"], ["ads"], []],
      [["Email marketing", "newsletter"], ["campaigns"], []],
      [["Monthly reporting"], ["reporting"], []],
      [["Website redesign + hosting"], ["website", "support"], []],
      [["Web development"], ["website"], []],
      [["Mobile app"], ["development"], []],
      [["Bookkeeping and VAT"], ["bookkeeping"], []],
      [["Payroll"], ["payroll"], []],
      [["Brand design"], ["branding"], []],
      [["Lead generation"], ["lead-capture"], []],
      [["SEO and social"], ["seo", "social"], []],
      [["seo", "social", "lead capture", "lead_capture"], ["seo", "social", "lead-capture"], []],
      [["Email campaigns"], ["campaigns"], []],
      [["Support and maintenance"], ["support"], []],
      [["Retainer"], [], ["Retainer"]],
      [["Bespoke thing", "SEO", "bespoke THING"], ["seo"], ["Bespoke thing"]],
      [["", "  ", "SEO"], ["seo"], []],
    ];
    for (const [input, services, other] of table) expect(normalizeServices(input), JSON.stringify(input)).toEqual({ services, other });
    // The order follows the list, not the input; non-text is ignored.
    expect(normalizeServices(["social", "seo"]).services).toEqual(["seo", "social"]);
    expect(normalizeServices([1, null, {}, "seo"] as unknown[])).toEqual({ services: ["seo"], other: [] });
    expect(normalizeServices(null)).toEqual({ services: [], other: [] });
  });

  it("says what was added and what was removed, in list order", () => {
    expect(diffServices(["seo"], ["social", "seo", "website"])).toEqual({ added: ["social", "website"], removed: [] });
    expect(diffServices(["seo", "social"], ["social"])).toEqual({ added: [], removed: ["seo"] });
    expect(diffServices([], [])).toEqual({ added: [], removed: [] });
  });

  it("keeps a step's origin id parseable, one id per client, service and day", () => {
    const origin = serviceStepOrigin("company", "acme", "seo", "20261003");
    expect(origin).toBe("crm:service-onboard:company:acme:seo:20261003");
    expect(parseServiceStep(origin)).toEqual({ kind: "company", clientId: "acme", service: "seo", day: "20261003" });
    for (const bad of [null, undefined, "crm:lead-followup:x", "crm:service-onboard:company:acme:seo", "crm:service-onboard:thing:acme:seo:1", "crm:service-onboard:company::seo:1"]) expect(parseServiceStep(bad as string)).toBeNull();
  });

  it("writes the step: what to check first, what starting means, the proof, and the canary warning", () => {
    const def = serviceDef("seo")!;
    const text = serviceStepContent({ def, client: { kind: "company", id: "acme", name: "Acme Plumbing", canary: false }, prefix: "PIB", missing: ["audience"] });
    expect(text.title).toBe("Start SEO for Acme Plumbing");
    expect(text.description).toContain("Acme Plumbing (`company:acme`) bought **SEO**");
    expect(text.description).toContain("First check whether it already runs");
    expect(text.description).toContain("/PIB/seo?client=company%3Aacme");
    expect(text.description).toContain("`partnersinbiz.seo:create-sprint`");
    expect(text.description).toContain("still missing: audience");
    expect(text.description).toContain("Done when** proof is logged on `company:acme`");
    expect(text.description).not.toContain("CANARY");
    const canary = serviceStepContent({ def, client: { kind: "company", id: "canary-1", name: "PiB Canary Co", canary: true }, prefix: "PIB", missing: [] });
    expect(canary.description).toContain("CANARY client");
    // A service with no module has no workspace link.
    expect(serviceStepContent({ def: serviceDef("website")!, client: { kind: "company", id: "acme", name: "Acme", canary: false }, prefix: null, missing: [] }).description).not.toContain("workspace)");
  });

  it("shows a client's services with the state of each step", () => {
    const steps = [
      { id: "1", companyId: CO, clientKind: "company" as const, clientRef: "acme", service: "seo", status: "started" as const, issueId: "i1", note: null, openedAt: null, completedAt: null },
      { id: "2", companyId: CO, clientKind: "company" as const, clientRef: "acme", service: "social", status: "dropped" as const, issueId: "i2", note: null, openedAt: null, completedAt: null },
    ];
    expect(stepsView(steps, ["seo", "social", "website"])).toEqual([
      { service: "seo", label: "SEO", state: "started", issueId: "i1" },
      { service: "social", label: "Social media", state: "not started", issueId: null },
      { service: "website", label: "Website", state: "not started", issueId: null },
    ]);
  });
});

function customerStore(extra: (store: Store) => void = () => undefined): Store {
  const store = seed();
  // Only this Paperclip company's clients: the foreign company in the shared seed would count as a second company.
  store.companies = store.companies!.filter((row) => row.company_id === CO);
  store.companies.find((row) => row.id === "acme")!.lifecycle = "customer";
  store.client_projects = [{ id: "cp1", company_id: CO, client_kind: "company", client_ref: "acme", project_id: "proj-acme", created_by: null, created_at: "2026-09-01T00:00:00Z" }];
  extra(store);
  return store;
}

const staff = (harness: Harness) => setRoles(harness, { operatorAgentId: "op-1", operatorStatus: "idle", team: { "seo-specialist": { agentId: "seo-1", status: "idle" }, social: { agentId: "soc-1", status: "idle" }, "account-manager": { agentId: "am-1", status: "idle" } } });
const steps = (store: Store) => (store.service_onboarding ?? []).map((row) => `${row.service}:${row.status}`).sort();
const emitted = (emit: { mock: { calls: any[][] } }, name: string) => emit.mock.calls.filter((call) => call[0] === name).map((call) => call[2] as Record<string, any>);

describe("a customer's service is added", () => {
  it("opens one step per service for the role that owns it, in the client's own project, and tells the other modules", async () => {
    const { harness, store, emit } = await boot({ store: customerStore() });
    await staff(harness);
    const result = await tool<Record<string, any>>(harness, "update-client-profile", { client: "company:acme", services: ["SEO retainer", "Social media", "Bookkeeping"] });
    expect(result.profile.services).toEqual(["seo", "social", "bookkeeping"]);
    expect(result.serviceSteps.opened.map((step: { service: string }) => step.service)).toEqual(["seo", "social", "bookkeeping"]);

    const issues = await crmIssues(harness);
    expect(issues.map((issue) => issue.title).sort()).toEqual(["Start Bookkeeping for Acme Plumbing", "Start SEO for Acme Plumbing", "Start Social media for Acme Plumbing"]);
    const byService = (service: string) => issues.find((issue) => issue.originId!.includes(`:${service}:`))!;
    expect(byService("seo").assigneeAgentId).toBe("seo-1");
    expect(byService("social").assigneeAgentId).toBe("soc-1");
    // No Bookkeeper staffed: the Operator (kit routing), never nobody.
    expect(byService("bookkeeping").assigneeAgentId).toBe("op-1");
    for (const issue of issues) {
      expect(issue.projectId).toBe("proj-acme");
      expect(issue.originId).toMatch(/^crm:service-onboard:company:acme:[a-z-]+:\d{8}$/);
      expect(issue.description).toContain("First check whether it already runs");
    }
    expect(steps(store)).toEqual(["bookkeeping:open", "seo:open", "social:open"]);
    expect(store.service_onboarding.find((row) => row.service === "seo")!.issue_id).toBe(byService("seo").id);

    const events = emitted(emit, CLIENT_SERVICES_EVENT);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ clientKind: "company", clientRef: "acme", clientName: "Acme Plumbing", services: ["seo", "social", "bookkeeping"], added: ["seo", "social", "bookkeeping"], removed: [] });
    expect(events[0]!.key).toMatch(/^crm:services:company:acme:\d+$/);
    expect(store.handoffs.filter((row) => row.event === CLIENT_SERVICES_EVENT)).toHaveLength(1);
  });

  it("does nothing the second time: the same list changes nothing, and one more service opens one more step", async () => {
    const { harness, store, emit } = await boot({ store: customerStore() });
    await staff(harness);
    await tool(harness, "update-client-profile", { client: "company:acme", services: ["seo", "social"] });
    const again = await tool<Record<string, any>>(harness, "update-client-profile", { client: "company:acme", services: ["social", "seo"] });
    expect(again.changed).toEqual([]);
    expect(again.serviceSteps).toBeUndefined();
    expect(await crmIssues(harness)).toHaveLength(2);
    expect(emitted(emit, CLIENT_SERVICES_EVENT)).toHaveLength(1);
    await tool(harness, "update-client-profile", { client: "company:acme", services: ["seo", "social", "website"] });
    expect(await crmIssues(harness)).toHaveLength(3);
    expect(steps(store)).toEqual(["seo:open", "social:open", "website:open"]);
    expect(emitted(emit, CLIENT_SERVICES_EVENT)[1]).toMatchObject({ added: ["website"], removed: [] });
  });

  it("a prospect's services are told to the other modules but open no step: they have not bought yet", async () => {
    const store = seed();
    const { harness, emit } = await boot({ store });
    await tool(harness, "update-client-profile", { client: "company:acme", services: ["seo"] });
    expect(emitted(emit, CLIENT_SERVICES_EVENT)).toHaveLength(1);
    expect(await crmIssues(harness)).toHaveLength(0);
    expect(store.service_onboarding).toHaveLength(0);
  });

  it("while the Cockpit's first-win onboarding is open the services are covered by it, not given steps of their own", async () => {
    const store = customerStore();
    cockpitOnboarding(store, "todo");
    const { harness } = await boot({ store });
    const result = await tool<Record<string, any>>(harness, "update-client-profile", { client: "company:acme", services: ["seo", "social"] });
    expect(result.serviceSteps).toMatchObject({ opened: [], covered: ["seo", "social"] });
    expect(steps(store)).toEqual(["seo:covered", "social:covered"]);
    expect((await crmIssues(harness))).toHaveLength(0);
    // Once that onboarding is done, a service added later is a step of its own.
    store.issues![0]!.status = "done";
    const later = await tool<Record<string, any>>(harness, "update-client-profile", { client: "company:acme", services: ["seo", "social", "campaigns"] });
    expect(later.serviceSteps.opened.map((step: { service: string }) => step.service)).toEqual(["campaigns"]);
    expect(steps(store)).toEqual(["campaigns:open", "seo:covered", "social:covered"]);
  });

  it("a service a person locked cannot be changed by an agent, so nothing is sent and nothing opens", async () => {
    const { harness, emit } = await boot({ store: customerStore() });
    await harness.performAction("crm.update-client-profile", { client: "company:acme", services: ["seo"] }, { companyId: CO, actor: BOARD });
    emit.mockClear();
    const refused = await toolRaw(harness, "update-client-profile", { client: "company:acme", services: ["seo", "social"] });
    expect(refused.error).toMatch(/Refused to overwrite human-owned fields: services/);
    expect(emitted(emit, CLIENT_SERVICES_EVENT)).toHaveLength(0);
    expect(await crmIssues(harness)).toHaveLength(1);
  });

  it("reports words that match no service as text, and still saves them", async () => {
    const { harness, store } = await boot({ store: customerStore() });
    const result = await tool<Record<string, any>>(harness, "update-client-profile", { client: "company:acme", services: ["SEO", "Bespoke consulting"] });
    expect(result.profile).toMatchObject({ services: ["seo"], servicesOther: ["Bespoke consulting"] });
    expect(result.unmappedServices).toEqual(["Bespoke consulting"]);
    expect(result.servicesNote).toMatch(/kept as text only: Bespoke consulting\. The services are: seo, ads, social/);
    expect(store.client_profiles[0]).toMatchObject({ services: ["seo"], services_other: ["Bespoke consulting"] });
    expect(store.client_profiles[0]!.services_normalized_at).toBeTruthy();
    // Free text only: still counts as filled in, so the profile does not say services are missing.
    const only = await tool<Record<string, any>>(harness, "update-client-profile", { client: "contact:solo", services: ["Something unusual"] });
    expect(only.profile.services).toEqual([]);
    expect(only.profile.missing).not.toContain("services");
  });
});

describe("a service is removed or added again", () => {
  it("cancels the open step, says why on it, and starts a new step if the service comes back", async () => {
    const { harness, store, emit } = await boot({ store: customerStore() });
    await staff(harness);
    await tool(harness, "update-client-profile", { client: "company:acme", services: ["seo", "social"] });
    const social = (await crmIssues(harness)).find((issue) => issue.originId!.includes(":social:"))!;
    const comment = vi.spyOn(harness.ctx.issues, "createComment");
    const result = await tool<Record<string, any>>(harness, "update-client-profile", { client: "company:acme", services: ["seo"] });
    expect(result.changed).toEqual(["services"]);
    expect(steps(store)).toEqual(["seo:open", "social:dropped"]);
    expect((await harness.ctx.issues.get(social.id, CO))!.status).toBe("cancelled");
    expect(comment).toHaveBeenCalledWith(social.id, expect.stringMatching(/Social media was removed from the client's services/), CO);
    expect(emitted(emit, CLIENT_SERVICES_EVENT)[1]).toMatchObject({ added: [], removed: ["social"], services: ["seo"] });

    await tool(harness, "update-client-profile", { client: "company:acme", services: ["seo", "social"] });
    expect(steps(store)).toEqual(["seo:open", "social:open"]);
    const issues = (await crmIssues(harness)).filter((issue) => issue.originId!.includes(":social:"));
    expect(issues).toHaveLength(2);
    expect(new Set(issues.map((issue) => issue.originId)).size).toBe(2);
    expect(store.service_onboarding.find((row) => row.service === "social")!.issue_id).toBe(issues.find((issue) => issue.status !== "cancelled")!.id);
  });

  it("leaves a step that was already done alone when its service is removed", async () => {
    const { harness, store } = await boot({ store: customerStore() });
    await tool(harness, "update-client-profile", { client: "company:acme", services: ["seo"] });
    const issue = (await crmIssues(harness))[0]!;
    await harness.ctx.issues.update(issue.id, { status: "done" }, CO);
    await onServiceStepIssue(harness.ctx, CO, { id: issue.id, status: "done", originId: issue.originId });
    expect(steps(store)).toEqual(["seo:started"]);
    await tool(harness, "update-client-profile", { client: "company:acme", services: [] });
    expect((await harness.ctx.issues.get(issue.id, CO))!.status).toBe("done");
  });
});

describe("the daily services check", () => {
  it("saves older free-text profiles in the list and keeps what does not map", async () => {
    const store = customerStore((s) => {
      s.client_profiles = [{ id: "pr1", company_id: CO, client_kind: "company", client_ref: "acme", brand_voice: null, audience: null, services: ["SEO retainer", "Bespoke thing"], website: null, booking_link: null, banned_words: [], tone_notes: null, human_owned: ["services"], updated_by: null, updated_at: "2026-09-20T00:00:00Z" }];
    });
    const { harness } = await boot({ store });
    expect((await runServicesCheck(harness.ctx)).backfilled).toBe(1);
    expect(store.client_profiles[0]).toMatchObject({ services: ["seo"], services_other: ["Bespoke thing"], human_owned: ["services"] });
    expect(store.client_profiles[0]!.services_normalized_at).toBeTruthy();
    // Done once: the second run saves nothing.
    expect((await runServicesCheck(harness.ctx)).backfilled).toBe(0);
  });

  it("opens the steps of a customer that was never onboarded (an imported client), once", async () => {
    const store = customerStore((s) => {
      s.client_profiles = [{ id: "pr1", company_id: CO, client_kind: "company", client_ref: "acme", services: ["seo", "website"], services_normalized_at: "2026-10-01T00:00:00Z", services_other: [], banned_words: [], human_owned: [] }];
    });
    const { harness } = await boot({ store });
    await staff(harness);
    const first = await runServicesCheck(harness.ctx);
    expect(first).toMatchObject({ companies: 1, opened: 2, covered: 0 });
    expect(steps(store)).toEqual(["seo:open", "website:open"]);
    expect((await crmIssues(harness)).map((issue) => issue.assigneeAgentId).sort()).toEqual(["op-1", "seo-1"]);
    expect(await runServicesCheck(harness.ctx)).toMatchObject({ opened: 0 });
    expect(await crmIssues(harness)).toHaveLength(2);
  });

  it("treats the services of a customer the Cockpit already onboarded as covered, whether that issue is open or done", async () => {
    for (const status of ["todo", "done"]) {
      const store = customerStore((s) => {
        s.client_profiles = [{ id: "pr1", company_id: CO, client_kind: "company", client_ref: "acme", services: ["seo"], services_normalized_at: "2026-10-01T00:00:00Z", services_other: [], banned_words: [], human_owned: [] }];
      });
      cockpitOnboarding(store, status);
      const { harness } = await boot({ store });
      expect(await runServicesCheck(harness.ctx)).toMatchObject({ opened: 0, covered: 1 });
      expect(steps(store)).toEqual(["seo:covered"]);
      expect(await crmIssues(harness)).toHaveLength(0);
    }
  });

  it("waits when it cannot read the Cockpit's issues, so it never opens a step that may duplicate it", async () => {
    const store = customerStore((s) => {
      s.client_profiles = [{ id: "pr1", company_id: CO, client_kind: "company", client_ref: "acme", services: ["seo"], services_normalized_at: "2026-10-01T00:00:00Z", services_other: [], banned_words: [], human_owned: [] }];
    });
    const { harness } = await boot({ store });
    const original = harness.ctx.db.query.bind(harness.ctx.db);
    vi.spyOn(harness.ctx.db, "query").mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes("public.issues")) throw new Error("issues unavailable");
      return original(sql, params);
    });
    expect(await runServicesCheck(harness.ctx)).toMatchObject({ opened: 0, covered: 0 });
    expect(store.service_onboarding).toHaveLength(0);
  });

  it("opens at most 8 new steps per company a day and the rest on the next days", async () => {
    const store = customerStore((s) => {
      for (let i = 0; i < 11; i += 1) {
        s.companies!.push({ ...s.companies![0]!, id: `cust-${i}`, name: `Customer ${i}`, domain: `c${i}.test`, lifecycle: "customer" });
        s.client_profiles!.push({ id: `pr-${i}`, company_id: CO, client_kind: "company", client_ref: `cust-${i}`, services: ["seo"], services_normalized_at: "2026-10-01T00:00:00Z", services_other: [], banned_words: [], human_owned: [] });
      }
    });
    const { harness } = await boot({ store });
    expect(MAX_NEW_STEPS_PER_RUN).toBe(8);
    expect(await runServicesCheck(harness.ctx)).toMatchObject({ opened: 8 });
    expect(await runServicesCheck(harness.ctx)).toMatchObject({ opened: 3 });
    expect(await runServicesCheck(harness.ctx)).toMatchObject({ opened: 0 });
    expect(await crmIssues(harness)).toHaveLength(11);
  });

  it("a customer with many services is capped too: 8 steps the first day, the rest the next", async () => {
    const store = customerStore((s) => {
      s.client_profiles = [{ id: "pr1", company_id: CO, client_kind: "company", client_ref: "acme", services: [...SERVICE_KEYS], services_normalized_at: "2026-10-01T00:00:00Z", services_other: [], banned_words: [], human_owned: [] }];
    });
    const { harness } = await boot({ store });
    expect(SERVICE_KEYS.length).toBeGreaterThan(MAX_NEW_STEPS_PER_RUN);
    expect(await runServicesCheck(harness.ctx)).toMatchObject({ opened: MAX_NEW_STEPS_PER_RUN });
    expect(await runServicesCheck(harness.ctx)).toMatchObject({ opened: SERVICE_KEYS.length - MAX_NEW_STEPS_PER_RUN });
    expect(await crmIssues(harness)).toHaveLength(SERVICE_KEYS.length);
  });

  it("skips a prospect, a client with no services, and a company whose settings are not saved", async () => {
    const store = seed();
    store.companies = store.companies!.filter((row) => row.company_id === CO);
    store.client_profiles = [{ id: "pr1", company_id: CO, client_kind: "company", client_ref: "acme", services: ["seo"], services_normalized_at: "2026-10-01T00:00:00Z", services_other: [], banned_words: [], human_owned: [] }];
    const prospect = await boot({ store });
    expect(await runServicesCheck(prospect.harness.ctx)).toMatchObject({ companies: 1, opened: 0 });
    const unsaved = await boot({ store: customerStore((s) => { s.client_profiles = store.client_profiles; }), config: {} });
    expect(await runServicesCheck(unsaved.harness.ctx)).toEqual({ companies: 0, backfilled: 0, opened: 0, covered: 0, started: 0 });
  });

  it("marks a step started once its issue is done, and dropped when it was cancelled (and the job does not open it again)", async () => {
    const store = customerStore((s) => {
      s.client_profiles = [{ id: "pr1", company_id: CO, client_kind: "company", client_ref: "acme", services: ["seo", "social"], services_normalized_at: "2026-10-01T00:00:00Z", services_other: [], banned_words: [], human_owned: [] }];
    });
    const { harness } = await boot({ store });
    await runServicesCheck(harness.ctx);
    const [seo, social] = ["seo", "social"].map((service) => store.service_onboarding.find((row) => row.service === service)!.issue_id as string);
    await harness.ctx.issues.update(seo!, { status: "done" }, CO);
    await harness.ctx.issues.update(social!, { status: "cancelled" }, CO);
    const result = await runServicesCheck(harness.ctx);
    expect(result.started).toBe(1);
    expect(result.opened).toBe(0);
    expect(steps(store)).toEqual(["seo:started", "social:dropped"]);
    // A person said it is not needed: the next days do not bring it back.
    expect(await runServicesCheck(harness.ctx)).toMatchObject({ opened: 0 });
    expect(steps(store)).toEqual(["seo:started", "social:dropped"]);
    expect(await crmIssues(harness)).toHaveLength(2);
  });

  it("runs from the daily job and from the board action, for one company", async () => {
    const store = customerStore((s) => {
      s.client_profiles = [{ id: "pr1", company_id: CO, client_kind: "company", client_ref: "acme", services: ["campaigns"], services_normalized_at: "2026-10-01T00:00:00Z", services_other: [], banned_words: [], human_owned: [] }];
    });
    const { harness } = await boot({ store });
    await harness.runJob("services-check");
    expect(steps(store)).toEqual(["campaigns:open"]);
    expect(await harness.performAction("crm.run-services-check", {}, { companyId: CO, actor: BOARD })).toMatchObject({ companies: 1, opened: 0 });
    expect(await harness.performAction("crm.normalize-services", {}, { companyId: CO, actor: BOARD })).toEqual({ saved: 0 });
  });
});

describe("closing a service step", () => {
  const issue = (originId: string) => ({ id: "iss-1", companyId: CO, identifier: "PIB-9", title: "Start SEO", originId, assigneeAgentId: "seo-1", createdAt: ago(60) });
  const origin = serviceStepOrigin("company", "acme", "seo", "20261003");
  const withProfile = (services: string[]) => customerStore((s) => {
    s.client_profiles = [{ id: "pr1", company_id: CO, client_kind: "company", client_ref: "acme", services, services_normalized_at: "2026-10-01T00:00:00Z", services_other: [], banned_words: [], human_owned: [] }];
  });
  const logged = (minutesAgo: number): Row => ({ id: `a-${minutesAgo}`, company_id: CO, record_type: "company", record_id: "acme", kind: "note", body: "x", issue_id: null, meta: null, source_key: null, created_at: ago(minutesAgo) });

  it("is reopened until proof is logged on the client since the step opened", async () => {
    const store = withProfile(["seo"]);
    const { harness } = await boot({ store });
    const result = await checkServiceStep(harness.ctx, issue(origin));
    expect(result.done).toBe(false);
    expect(result.missing![0]).toMatch(/Nothing is logged on `company:acme` since this step opened: log the proof that SEO is running/);
    // Proof from before the step opened does not count; proof since does.
    store.activities = [logged(120)];
    expect((await checkServiceStep(harness.ctx, issue(origin))).done).toBe(false);
    store.activities = [logged(120), logged(5)];
    expect(await checkServiceStep(harness.ctx, issue(origin))).toEqual({ done: true });
  });

  it("stands when the service was removed, the client is gone, or the issue is not a service step", async () => {
    const { harness, store } = await boot({ store: withProfile(["social"]) });
    expect(await checkServiceStep(harness.ctx, issue(origin))).toEqual({ done: true });
    store.client_profiles = [];
    expect(await checkServiceStep(harness.ctx, issue(origin))).toEqual({ done: true });
    expect(await checkServiceStep(harness.ctx, issue("crm:lead-followup:x"))).toEqual({ done: true });
    expect(await closeStands(harness.ctx, issue("crm:service-onboard:company:acme:seo:20261003"))).toBe(true);
  });

  it("an agent's close without proof is reopened, and the service is not started until it stands", async () => {
    const store = customerStore((s) => {
      s.client_profiles = [];
    });
    const { harness } = await boot({ store });
    await tool(harness, "update-client-profile", { client: "company:acme", services: ["seo", "social"] });
    const seo = (await crmIssues(harness)).find((row) => row.originId!.includes(":seo:"))!;
    expect(steps(store)).toEqual(["seo:open", "social:open"]);
    await harness.ctx.issues.update(seo.id, { status: "done" }, CO);
    await harness.emit("issue.updated", { actorType: "agent" }, { companyId: CO, entityId: seo.id, entityType: "issue", actorType: "agent" });
    // No proof: the kit reopens it, so it is not started.
    expect((await harness.ctx.issues.get(seo.id, CO))!.status).not.toBe("done");
    expect(steps(store)).toEqual(["seo:open", "social:open"]);
    // Proof logged, then closed again: now it stands and the service is started.
    store.activities = [{ ...logged(0), created_at: new Date(Date.now() + 1000).toISOString() }];
    await harness.ctx.issues.update(seo.id, { status: "done" }, CO);
    await harness.emit("issue.updated", {}, { companyId: CO, entityId: seo.id, entityType: "issue", actorType: "agent" });
    expect((await harness.ctx.issues.get(seo.id, CO))!.status).toBe("done");
    expect(steps(store)).toEqual(["seo:started", "social:open"]);
  });

  it("is not a step: other issues are left alone", async () => {
    const { harness } = await boot({ store: withProfile(["seo"]) });
    expect(await onServiceStepIssue(harness.ctx, CO, { id: "x", status: "done", originId: "crm:reply:m1" })).toBe(false);
    expect(await onServiceStepIssue(harness.ctx, CO, { id: "x", status: "todo", originId: origin })).toBe(true);
  });
});

describe("migration 010", () => {
  const sql = readFileSync(new URL("../migrations/010_crm.sql", import.meta.url), "utf8");

  it("passes the host migration guard, with no quotes in comments and nothing deleted", () => {
    for (const statement of splitSqlStatements(sql)) expect(() => validateMigrationStatement(statement, NAMESPACE), statement.slice(0, 80)).not.toThrow();
    for (const line of sql.split("\n").filter((row) => row.trim().startsWith("--"))) expect(line).not.toMatch(/['"`]/);
    expect(sql).toContain(`CREATE TABLE ${NAMESPACE}.service_onboarding`);
    for (const column of ["logo_key", "primary_color", "secondary_color", "accent_color", "fonts", "tone_examples", "scope_template_ref", "terms_ref", "services_other", "services_normalized_at"]) expect(sql).toContain(`ADD COLUMN ${column}`);
    expect(sql).not.toMatch(/\bdelete\b/i);
  });
});
