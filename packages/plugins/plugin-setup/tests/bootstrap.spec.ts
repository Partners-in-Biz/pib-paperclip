import { describe, expect, it } from "vitest";
import {
  BOOTSTRAP_STEPS,
  clip,
  defaultsFromSchema,
  currentGrants,
  grantsMarkdown,
  isStepId,
  isStepStatus,
  missingHandlerError,
  needsSettingsError,
  ownerGrants,
  personItems,
  planSteps,
  runStatus,
  sanitizeGrants,
  sanitizeItems,
  SKILL_SYNC_ACTIONS,
  stepDef,
  stepLabel,
  type GrantInput,
  type OwnerGrant,
  type PlanFacts,
} from "../src/bootstrap.js";
import { pickHiringAgent, toHiringCandidates } from "../src/hiring.js";
import { MODULES, MODULE_KEYS, type SetupItem, type SetupStatus } from "../src/kit-setup.js";
import { allModulesOn } from "../src/modules.js";

const facts = (patch: Partial<PlanFacts> = {}): PlanFacts => ({ modulesSaved: false, setupSettingsSaved: false, finishIssueId: null, requiredLeft: null, ...patch });
const perms = { canCreateAgents: true };
const withCeo = pickHiringAgent(toHiringCandidates([{ id: "ceo", name: "Boss", role: "general", title: "CEO", status: "idle", reportsTo: null, permissions: perms }]));
const noCeo = pickHiringAgent([]);

const input = (patch: Partial<GrantInput> = {}): GrantInput => ({
  company: { id: "co-1", name: "Acme", prefix: "ACM" },
  modules: allModulesOn(),
  installed: null,
  hiring: withCeo,
  requireApproval: false,
  statuses: {},
  starterPackApproved: false,
  ...patch,
});

describe("the steps", () => {
  it("run in a fixed order, and say who runs each", () => {
    expect(BOOTSTRAP_STEPS.map((step) => step.id)).toEqual(["modules", "setup-settings", "plugin-settings", "skills", "roles", "templates", "company-wiki", "starter-pack", "finish-issue", "owner-list"]);
    expect(BOOTSTRAP_STEPS.filter((step) => step.where === "worker").map((step) => step.id)).toEqual(["modules", "finish-issue"]);
    expect(stepDef("roles")?.where).toBe("page");
    expect(stepDef("nope")).toBeNull();
    expect(isStepId("skills")).toBe(true);
    expect(isStepId("grants")).toBe(false);
    expect(isStepStatus("needs_owner")).toBe(true);
    expect(isStepStatus("ok")).toBe(false);
    expect(stepLabel("needs_owner")).toBe("Needs you");
  });

  it("has a sync action for every PiB plugin that has skills, and none for Setup or the wiki", () => {
    const pluginKeys = MODULE_KEYS.flatMap((key) => [...MODULES[key].plugins]).filter((key) => key.startsWith("partnersinbiz."));
    for (const key of pluginKeys) expect(SKILL_SYNC_ACTIONS[key], key).toMatch(/^[a-z]+\.(sync-skills|load)$/);
    expect(SKILL_SYNC_ACTIONS["partnersinbiz.setup"]).toBeUndefined();
    expect(SKILL_SYNC_ACTIONS["paperclipai.plugin-llm-wiki"]).toBeUndefined();
  });
});

describe("planning from stored state and live facts", () => {
  it("shows every step pending for a company the bootstrap never touched", () => {
    const steps = planSteps(null, facts());
    expect(steps.every((step) => step.status === "pending" && !step.derived)).toBe(true);
    expect(runStatus(steps)).toBe("created");
  });

  it("lets a live fact win over the stored record: saved modules, saved Setup settings, an open Finish issue", () => {
    const steps = planSteps({ steps: { modules: { status: "failed", detail: "x", at: null } } }, facts({ modulesSaved: true, setupSettingsSaved: true, finishIssueId: "issue-1" }));
    const by = Object.fromEntries(steps.map((step) => [step.id, step]));
    expect(by.modules).toMatchObject({ status: "done", derived: true });
    expect(by["setup-settings"]).toMatchObject({ status: "done", derived: true });
    expect(by["finish-issue"]).toMatchObject({ status: "done", derived: true });
    expect(by["plugin-settings"]).toMatchObject({ status: "pending", derived: false });
  });

  it("treats the Finish issue as done when nothing required is missing, and keeps a stored done as it was", () => {
    expect(planSteps(null, facts({ requiredLeft: 0 })).find((step) => step.id === "finish-issue")).toMatchObject({ status: "done", derived: true });
    const steps = planSteps({ steps: { modules: { status: "done", detail: "kept", at: "t" } } }, facts({ modulesSaved: true }));
    expect(steps[0]).toMatchObject({ status: "done", detail: "kept", derived: false });
  });

  it("works out the run status: created, running, partial, complete (a step that waits for the owner is not a failure)", () => {
    expect(runStatus([{ status: "pending" }, { status: "pending" }])).toBe("created");
    expect(runStatus([{ status: "done" }, { status: "pending" }])).toBe("running");
    expect(runStatus([{ status: "done" }, { status: "running" }])).toBe("running");
    expect(runStatus([{ status: "done" }, { status: "failed" }])).toBe("partial");
    expect(runStatus([{ status: "done" }, { status: "blocked" }])).toBe("partial");
    expect(runStatus([{ status: "done" }, { status: "needs_owner" }, { status: "skipped" }])).toBe("complete");
  });
});

describe("plugin settings defaults", () => {
  it("reads defaults from a schema, nested objects included, and ignores secret fields with no default", () => {
    const schema = {
      type: "object",
      properties: {
        weeklyIssue: { type: "boolean", default: true },
        jev: { type: "object", properties: { enabled: { type: "boolean", default: false }, model: { type: "string", default: "jev-1" }, apiKey: { format: "secret-ref" } } },
        empty: { type: "object", properties: { key: { type: "string" } } },
        text: { type: "string" },
      },
    };
    expect(defaultsFromSchema(schema)).toEqual({ weeklyIssue: true, jev: { enabled: false, model: "jev-1" } });
    expect(defaultsFromSchema(null)).toEqual({});
    expect(defaultsFromSchema({ properties: "x" })).toEqual({});
  });

  it("tells a missing-settings error and a missing-handler error apart", () => {
    expect(needsSettingsError("company context is required for this call")).toBe(true);
    expect(needsSettingsError("Plugin is not allowed to perform")).toBe(false);
    expect(missingHandlerError("No action handler registered for crm.sync-skills")).toBe(true);
    expect(missingHandlerError("boom")).toBe(false);
  });
});

describe("the one list of grants only a person can give", () => {
  const titles = (grants: OwnerGrant[]) => grants.map((grant) => grant.id);

  it("starts with the missing hiring agent and its fix when nobody can hire", () => {
    const grants = ownerGrants(input({ hiring: noCeo }));
    expect(grants[0]).toMatchObject({ id: "hiring-agent", title: "Create the company's CEO agent", href: "/agents/new" });
    expect(grants[0]!.steps[0]).toMatch(/Agents -> New agent, role CEO/);
    expect(grants[0]!.command).toMatch(/new-company\.py --company <id> --create-ceo --apply/);
    expect(titles(ownerGrants(input()))).not.toContain("hiring-agent");
    // Unknown (agents not read yet): no claim either way.
    expect(titles(ownerGrants(input({ hiring: null })))).not.toContain("hiring-agent");
  });

  it("asks for the approval of new agents only when the company requires it", () => {
    expect(titles(ownerGrants(input({ requireApproval: true })))).toContain("approve-hires");
    expect(titles(ownerGrants(input({ requireApproval: false })))).not.toContain("approve-hires");
    expect(titles(ownerGrants(input({ requireApproval: null })))).not.toContain("approve-hires");
  });

  it("always lists the keys, the per-company GitHub token (nobody but the owner creates it) and resuming the agents", () => {
    const grants = ownerGrants(input({ sourceCompany: { id: "src-1", name: "Partners in Biz" } }));
    const secrets = grants.find((grant) => grant.id === "plugin-secrets")!;
    expect(secrets.command).toBe("python3 /root/pib-ops/copy-company-secrets.py --from src-1 --to co-1");
    expect(secrets.steps.join(" ")).toMatch(/--relink-config/);
    expect(secrets.href).toBe("/company/settings/secrets");
    const token = grants.find((grant) => grant.id === "github-token")!;
    expect(token.steps.join(" ")).toMatch(/Fine-grained tokens/);
    expect(token.steps.join(" ")).toMatch(/No admin, no workflows/);
    expect(token.steps.join(" ")).toMatch(/named GITHUB_TOKEN/);
    expect(token.why).toMatch(/no agent may ever type it/);
    expect(titles(grants)).toContain("resume-agents");
  });

  it("lists what each switched-on module needs while its plugin has not reported, and nothing for a module that is off", () => {
    const grants = ownerGrants(input({ modules: { ...allModulesOn(), social: false, payroll: false } }));
    const ids = titles(grants);
    expect(ids).toContain("partnersinbiz.mailbox:gmail");
    expect(ids).toContain("partnersinbiz.seo:search-console");
    expect(ids).toContain("partnersinbiz.billing:billing-details");
    expect(ids).not.toContain("partnersinbiz.social:accounts");
    expect(ids).not.toContain("partnersinbiz.payroll:employer");
    expect(grants.find((grant) => grant.id === "partnersinbiz.mailbox:gmail")).toMatchObject({ title: "Mailbox (Gmail): Connect Gmail", href: "/mailbox" });
  });

  it("uses the plugin's own missing items once it reported: the person's steps only, never a hire or an action", () => {
    const item = (key: string, extra: Partial<SetupItem> = {}): SetupItem => ({ key, title: key, status: "missing", required: true, ...extra });
    const status: SetupStatus = {
      plugin: "partnersinbiz.seo",
      module: "seo",
      title: "SEO",
      checkedAt: "2026-10-03T10:00:00.000Z",
      items: [
        item("settings"),
        item("agent", { href: "/setup?section=team#team-seo-specialist" }),
        item("button", { action: { plugin: "partnersinbiz.seo", key: "seo.do", label: "Do it" } }),
        item("google", { title: "Add the service account", detail: "Only a site owner can.", steps: ["Open Search Console."], href: "/seo", hrefLabel: "Open SEO", agentNext: "Starts the sprint." }),
        item("done-one", { status: "done" }),
        item("optional-one", { required: false }),
      ],
    };
    expect(personItems(status).map((entry) => entry.key)).toEqual(["google"]);
    const grants = ownerGrants(input({ statuses: { "partnersinbiz.seo": status }, modules: { ...allModulesOn(), mailbox: false } }));
    const seo = grants.filter((grant) => grant.id.startsWith("partnersinbiz.seo:"));
    expect(seo).toEqual([expect.objectContaining({ id: "partnersinbiz.seo:google", title: "SEO: Add the service account", why: "Only a site owner can.", steps: ["Open Search Console."], after: "Starts the sprint." })]);
  });

  it("skips a plugin that is not installed", () => {
    const grants = ownerGrants(input({ installed: { "partnersinbiz.crm": {} } }));
    expect(titles(grants).some((id) => id.startsWith("partnersinbiz.mailbox:"))).toBe(false);
  });

  it("marks the tools:use grant and the starter pack as decisions, and drops the pack once it is approved", () => {
    const grants = ownerGrants(input());
    expect(grants.find((grant) => grant.id === "tools-grant")).toMatchObject({ decision: true });
    expect(grants.find((grant) => grant.id === "tools-grant")!.steps.join(" ")).toMatch(/Recommended: the narrow grant for the four memory tools/);
    expect(grants.find((grant) => grant.id === "starter-pack")).toMatchObject({ decision: true, href: "/setup?section=new-company" });
    expect(titles(ownerGrants(input({ starterPackApproved: true })))).not.toContain("starter-pack");
    // Setup never grants it: the list says so and offers no command for it.
    expect(grants.find((grant) => grant.id === "tools-grant")!.command).toBeNull();
  });

  it("renders as markdown for the Finish setup issue, with the company prefix on paths and a command in code", () => {
    const grants = ownerGrants(input({ hiring: noCeo }));
    const md = grantsMarkdown(grants, "ACM");
    expect(md).toContain("## Needs you (one time)");
    expect(md).toContain("1. **Create the company's CEO agent**");
    expect(md).toContain("[New agent](/ACM/agents/new)");
    expect(md).toContain("`python3 /root/pib-ops/new-company.py --company <id> --create-ceo --apply`");
    expect(md).toContain("(a decision)");
    expect(grantsMarkdown([], "ACM")).toBe("");
  });
});

describe("grants that are still true", () => {
  const grant = (id: string): OwnerGrant => ({ id, title: id, why: "w", steps: [], href: null, hrefLabel: null, command: null, after: "a", decision: false });
  const status = (plugin: string, items: Array<[string, string]>) => ({ plugin, module: null, title: plugin, checkedAt: "2026-10-03T10:00:00.000Z", items: items.map(([key, itemStatus]) => ({ key, title: key, status: itemStatus, required: true })) }) as never;

  it("drops a plugin item once the plugin reports it done, and keeps what Setup cannot check", () => {
    const grants = [grant("partnersinbiz.crm:import"), grant("partnersinbiz.crm:gmail"), grant("partnersinbiz.seo:service_account"), grant("github-token"), grant("plugin-secrets")];
    const statuses = { "partnersinbiz.crm": status("partnersinbiz.crm", [["import", "done"], ["gmail", "missing"]]) };
    expect(currentGrants(grants, statuses).map((entry) => entry.id)).toEqual(["partnersinbiz.crm:gmail", "partnersinbiz.seo:service_account", "github-token", "plugin-secrets"]);
  });

  it("keeps a stand-in grant when the plugin's report has no such item, and changes nothing with no reports", () => {
    const grants = [grant("partnersinbiz.mailbox:gmail")];
    expect(currentGrants(grants, { "partnersinbiz.mailbox": status("partnersinbiz.mailbox", [["connected", "done"]]) })).toEqual(grants);
    expect(currentGrants(grants, {})).toEqual(grants);
    expect(currentGrants([], {})).toEqual([]);
  });
});

describe("what the page may report", () => {
  it("clips and cleans text", () => {
    expect(clip("  a   b\n c ", 10)).toBe("a b c");
    expect(clip("x".repeat(20), 10)).toBe(`${"x".repeat(9)}…`);
    expect(clip(5, 10)).toBe("");
  });

  it("keeps at most 40 items with a known status and short text, and drops the rest", () => {
    const rows = Array.from({ length: 60 }, (_v, index) => ({ key: `k${index}`, label: `Label ${index}`, status: "done", detail: "d".repeat(500) }));
    const items = sanitizeItems([...rows, { key: "bad", label: "Bad", status: "weird" }, { label: "no key", status: "done" }, "nope"]);
    expect(items).toHaveLength(40);
    expect(items[0]!.detail!.length).toBe(300);
    expect(sanitizeItems("x")).toEqual([]);
    expect(sanitizeItems([{ key: "a", label: "A", status: "failed" }])).toEqual([{ key: "a", label: "A", status: "failed" }]);
  });

  it("accepts a grant only with an id and a title, keeps safe links and drops script and data links", () => {
    const grants = sanitizeGrants([
      { id: "a", title: "A", why: "w", steps: ["one", "two"], href: "/mailbox", hrefLabel: "Open", command: "run it", after: "next", decision: true },
      { id: "b", title: "B", href: "javascript:alert(1)" },
      { id: "c", title: "C", href: "data:text/html,x" },
      { id: "d", title: "D", href: "https://example.com/x" },
      { id: "a", title: "duplicate" },
      { title: "no id" },
      { id: "e" },
    ]);
    expect(grants.map((grant) => grant.id)).toEqual(["a", "b", "c", "d"]);
    expect(grants[0]).toMatchObject({ href: "/mailbox", hrefLabel: "Open", command: "run it", decision: true });
    expect(grants[1]).toMatchObject({ href: null, hrefLabel: null });
    expect(grants[2]!.href).toBeNull();
    expect(grants[3]!.href).toBe("https://example.com/x");
    expect(sanitizeGrants(Array.from({ length: 80 }, (_v, index) => ({ id: `g${index}`, title: "t" })))).toHaveLength(40);
    expect(sanitizeGrants({})).toEqual([]);
  });
});
