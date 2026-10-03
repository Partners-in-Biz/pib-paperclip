import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { teamRole } from "@partnersinbiz/pib-plugin-kit/team";
import { pickHiringAgent, toHiringCandidates } from "../src/hiring.js";
import { matureCompanyWarning, MATURE_AGENT_COUNT, ownerGrants, planSteps, type OwnerGrant } from "../src/bootstrap.js";
import { allModulesOn } from "../src/modules.js";
import { emptyRoleState, modelLabel, parseCompanyAgents, runProfileProblemsFor, runProfileText, setupFocus, type TeamAgent } from "../src/team.js";
import { loadPack, templateByKey } from "../src/templates.js";
import { loadStarterPack } from "../src/starter-pack.js";
import { starterPackHash } from "../src/new-company.js";
import { GrantList, NewCompanyView, StarterPackCard, StepRow, TemplateList, templateRowState, type NewCompanyState, type NewCompanyViewProps, type StarterPackView } from "../src/ui/new-company.js";
import { HiringNotice, RunProfileLine } from "../src/ui/team.js";

const linkFor = (href: string) => ({ href: `/ACM${href}` });
const perms = { canCreateAgents: true };
const ceo = pickHiringAgent(toHiringCandidates([{ id: "ceo", name: "PiB", role: "general", title: "CEO", status: "idle", reportsTo: null, permissions: perms }]));
const nobody = pickHiringAgent([]);

const pack = loadStarterPack();
const starter = (patch: Partial<StarterPackView> = {}): StarterPackView => ({
  name: pack.name,
  version: pack.version,
  hash: starterPackHash(pack),
  status: "candidate",
  needsOwnerOk: true,
  builtFrom: pack.builtFrom,
  howToUse: pack.howToUse,
  reviewNotes: pack.reviewNotes,
  facts: pack.facts,
  excluded: pack.excluded,
  factCount: pack.facts.length,
  excludedCount: pack.excluded.length,
  approved: false,
  approvedBy: null,
  approvedAt: null,
  importedAt: null,
  ...patch,
});

const state = (patch: Partial<NewCompanyState> = {}): NewCompanyState => ({
  run: null,
  status: "created",
  steps: planSteps(null, { modulesSaved: false, setupSettingsSaved: false, finishIssueId: null, requiredLeft: null }),
  facts: { modulesSaved: false, setupSettingsSaved: false, finishIssueId: null, requiredLeft: null },
  hires: [],
  starterPack: starter(),
  pack: { name: "pib-standard-team", version: 1, updated: "2026-10-03", templates: 11 },
  ...patch,
} as NewCompanyState);

const props = (patch: Partial<NewCompanyViewProps> = {}): NewCompanyViewProps => ({
  companyName: "Acme Ltd",
  state: state(),
  hiring: ceo,
  agents: [{ id: "ceo", name: "PiB", title: "CEO", role: "general", status: "idle" }],
  options: {},
  onOptions: () => undefined,
  sources: [{ id: "src", name: "Partners in Biz", issuePrefix: "PAR" }],
  running: false,
  busyStep: null,
  message: "",
  settingsSaved: true,
  grants: [],
  linkFor,
  onRun: () => undefined,
  onRunStep: () => undefined,
  onApprove: () => undefined,
  approving: false,
  onPreview: () => undefined,
  previewBusy: null,
  canApprove: true,
  ...patch,
});

const html = (p: NewCompanyViewProps) => renderToStaticMarkup(createElement(NewCompanyView, p));

describe("the New company view", () => {
  it("shows the run button, every step, the template pack and the starter pack for a company never touched", () => {
    const out = html(props());
    expect(out).toContain("Set up Acme Ltd");
    expect(out).toContain("Set up this company");
    expect(out).toContain("Not run yet");
    for (const title of ["Choose the modules this company uses", "Save every plugin&#x27;s settings", "Open a hire task for every team role", "What only you can do"]) expect(out).toContain(title);
    for (const template of loadPack().templates) expect(out).toContain(`data-template="${template.key}"`);
    expect(out).toContain("Memory starter pack");
    expect(out).toContain("Needs owner OK");
    expect(out).toContain("PiB does the hiring (its title is CEO). Hire tasks go to it.");
    expect(out).not.toContain("no-hiring-agent");
  });

  it("shows the problem and the fix when nobody can hire", () => {
    const out = html(props({ hiring: nobody, agents: [] }));
    expect(out).toContain('data-testid="no-hiring-agent"');
    expect(out).toContain("Nobody can do this company&#x27;s hiring yet");
    expect(out).toContain("Agents -&gt; New agent, role CEO");
  });

  it("warns, with a button, when Setup's own settings are not saved (Q7-7)", () => {
    const out = html(props({ settingsSaved: false, onSaveSetup: () => undefined }));
    expect(out).toContain('data-testid="setup-settings-warning"');
    expect(out).toContain("Setup&#x27;s own settings are not saved for this company");
    expect(out).toContain("Save Setup&#x27;s settings");
    expect(html(props({ settingsSaved: true }))).not.toContain("setup-settings-warning");
  });

  it("says what a run is doing and what it left", () => {
    expect(html(props({ state: state({ status: "running" }), running: true }))).toContain("Running…");
    expect(html(props({ state: state({ status: "partial" }) }))).toContain("Some steps need attention");
    const done = html(props({ state: state({ status: "complete" }) }));
    expect(done).toContain("Complete");
    expect(done).toContain("Run again");
    expect(html(props({ message: "2 steps failed: see the reason on each." }))).toContain("2 steps failed");
  });

  it("says a run that was interrupted is still open, instead of claiming it is running", () => {
    const interrupted = html(props({ state: state({ status: "running" }), running: false }));
    expect(interrupted).toContain("In progress");
    expect(interrupted).toContain('data-testid="run-interrupted"');
    expect(interrupted).toContain("Run again");
    expect(html(props({ state: state({ status: "running" }), running: true }))).not.toContain("run-interrupted");
    expect(html(props({ state: state({ status: "complete" }) }))).not.toContain("run-interrupted");
  });

  it("warns before a first run on a company that already works, and not otherwise", () => {
    const warning = matureCompanyWarning({ agents: Array.from({ length: 8 }, (_v, index) => ({ status: index === 0 ? "terminated" : "idle" })), runStatus: "created" });
    expect(warning).toMatch(/already has 7 agents/);
    const out = html(props({ matureWarning: warning }));
    expect(out).toContain('data-testid="mature-company-warning"');
    expect(out).toContain("This company already works");
    expect(html(props({ matureWarning: null }))).not.toContain("mature-company-warning");
  });

  it("offers the sources to copy from and the optional roles", () => {
    const out = html(props({ options: { includeOptionalRoles: true } }));
    expect(out).toContain("Partners in Biz");
    expect(out).toContain("Nothing: use each plugin&#x27;s defaults");
    expect(out).toContain("Also hire the optional roles");
    expect(out).toMatch(/type="checkbox" checked=""/);
  });
});

describe("the mature-company guard", () => {
  const agents = (count: number, status = "idle") => Array.from({ length: count }, () => ({ status }));
  it("needs enough live agents, a run that never started and a readable agent list", () => {
    expect(matureCompanyWarning({ agents: agents(MATURE_AGENT_COUNT - 1), runStatus: "created" })).toBeNull();
    expect(matureCompanyWarning({ agents: agents(MATURE_AGENT_COUNT), runStatus: "created" })).toMatch(new RegExp(`already has ${MATURE_AGENT_COUNT} agents`));
    expect(matureCompanyWarning({ agents: agents(MATURE_AGENT_COUNT + 4), runStatus: "running" })).toBeNull();
    expect(matureCompanyWarning({ agents: agents(MATURE_AGENT_COUNT + 4), runStatus: "complete" })).toBeNull();
    expect(matureCompanyWarning({ agents: null, runStatus: "created" })).toBeNull();
    // Terminated agents do not make a company mature.
    expect(matureCompanyWarning({ agents: agents(20, "terminated"), runStatus: "created" })).toBeNull();
  });
});

describe("a step row", () => {
  const steps = (status: string, detail: string | null = null, items?: unknown[]) => ({ ...planSteps(null, { modulesSaved: false, setupSettingsSaved: false, finishIssueId: null, requiredLeft: null })[3]!, status, detail, ...(items ? { items } : {}) }) as never;

  it("lets a failed page step be tried again, and shows each item and why it failed", () => {
    const failed = renderToStaticMarkup(createElement(StepRow, { step: steps("failed", "1 plugin: 1 failed.", [{ key: "crm", label: "CRM", status: "failed", detail: "Could not read settings (500)" }]), onRun: () => undefined }));
    expect(failed).toContain("Failed");
    expect(failed).toContain("Try again");
    expect(failed).toContain("1 item");
    expect(failed).toContain("Could not read settings (500)");
  });

  it("has no button for a done step, a step Setup runs itself, or a step that is running", () => {
    expect(renderToStaticMarkup(createElement(StepRow, { step: steps("done"), onRun: () => undefined }))).not.toMatch(/<button/);
    const worker = { ...planSteps(null, { modulesSaved: false, setupSettingsSaved: false, finishIssueId: null, requiredLeft: null })[0]!, status: "failed" } as never;
    expect(renderToStaticMarkup(createElement(StepRow, { step: worker, onRun: () => undefined }))).not.toMatch(/<button/);
    expect(renderToStaticMarkup(createElement(StepRow, { step: steps("pending"), busy: true, onRun: () => undefined }))).not.toMatch(/<button/);
    expect(renderToStaticMarkup(createElement(StepRow, { step: steps("pending"), onRun: () => undefined }))).toContain("Run this step");
  });
});

describe("the list of grants", () => {
  it("prints each grant with its steps, command and link, and marks decisions", () => {
    const grants: OwnerGrant[] = ownerGrants({ company: { id: "co-1", name: "Acme", prefix: "ACM" }, modules: allModulesOn(), installed: null, hiring: nobody, requireApproval: true, statuses: {}, starterPackApproved: false, sourceCompany: { id: "src-1", name: "PiB" } });
    const out = renderToStaticMarkup(createElement(GrantList, { grants, linkFor }));
    expect(out).toContain('data-testid="owner-grants"');
    expect(out).toContain("Create the company&#x27;s CEO agent");
    expect(out).toContain("Approve the new agents");
    expect(out).toContain("copy-company-secrets.py --from src-1 --to co-1");
    expect(out).toContain('href="/ACM/agents/new"');
    expect(out).toContain("a decision");
    expect(out).toContain("Once done:");
    expect(renderToStaticMarkup(createElement(GrantList, { grants: [], linkFor }))).toContain("Nothing needs you yet");
  });
});

describe("the template list", () => {
  const rows = (agents: Array<{ id: string; name: string; title?: string | null; status: string; role?: string | null }>, hires: Array<{ templateKey: string; issueId: string; status: string }> = []) =>
    Object.fromEntries(loadPack().templates.map((template) => [template.key, templateRowState(template, { agents, hires, hiring: ceo })]));

  it("counts the CEO as staffed by the hiring agent, and shows staffed, hiring and missing", () => {
    const r = rows([{ id: "dl", name: "Delivery Lead", status: "idle" }], [{ templateKey: "planner", issueId: "i1", status: "open" }]);
    expect(r.ceo).toEqual({ state: "staffed", by: "PiB" });
    expect(r["delivery-lead"]).toMatchObject({ state: "staffed", by: "Delivery Lead" });
    expect(r.planner!.state).toBe("hiring");
    expect(r.developer!.state).toBe("missing");
    const out = renderToStaticMarkup(createElement(TemplateList, { templates: loadPack().templates, rows: r, selected: new Set(["developer"]), onToggle: () => undefined, onPreview: () => undefined }));
    expect(out).toContain("Staffed: PiB");
    expect(out).toContain("Hire task open");
    expect(out).toContain("Not hired");
    expect(out).toContain("reports to Delivery Lead");
    expect(out).toContain("Sonnet · 60 min per run · up to 4 at once");
    expect(out).toContain("made by LLM Wiki");
    expect(out).toContain("built in");
    // Only a template nobody holds can be ticked; the selected one is checked.
    expect(out).toMatch(/data-template="developer"[\s\S]*?checked=""/);
  });

  it("leaves the CEO template for a person to hire when nobody can", () => {
    const r = templateRowState(templateByKey("ceo")!, { agents: [], hires: [], hiring: nobody });
    expect(r.state).toBe("missing");
  });
});

describe("the starter pack card", () => {
  const card = (pack: StarterPackView, selected = false) => renderToStaticMarkup(createElement(StarterPackCard, { pack, selected, onSelect: () => undefined, onApprove: () => undefined, canApprove: true }));

  it("is marked as needing the owner's OK, lists the facts to read, and cannot be ticked until approved", () => {
    const out = card(starter());
    expect(out).toContain("Needs owner OK");
    expect(out).toContain(`Read the ${loadStarterPack().facts.length} facts`);
    expect(out).toContain("Approve this version");
    expect(out).toContain("The checkbox unlocks once the owner approves.");
    expect(out).toMatch(/disabled=""[^>]*type="checkbox"|type="checkbox"[^>]*disabled=""/);
    expect(out).toContain("22 other facts were reviewed and left out");
    expect(out).toContain("Call partnersinbiz.* plugin tools as MCP tools");
  });

  it("shows it approved, lets it be ticked, and shows when it was seeded", () => {
    const approved = card(starter({ approved: true, approvedBy: "owner-1", approvedAt: "2026-10-03T10:00:00.000Z" }), true);
    expect(approved).toContain("Approved by the owner");
    expect(approved).toContain("Approved 2026-10-03.");
    expect(approved).not.toContain("The checkbox unlocks");
    expect(card(starter({ approved: true, importedAt: "2026-10-04T08:00:00.000Z" }))).toContain("Seeded 2026-10-04");
  });
});

describe("Team: who hires, and the run profile", () => {
  it("names the hiring agent, or shows the problem and the fix", () => {
    expect(renderToStaticMarkup(createElement(HiringNotice, { hiring: ceo }))).toContain("PiB does the hiring (its title is CEO). Hire tasks go to it by default.");
    const out = renderToStaticMarkup(createElement(HiringNotice, { hiring: nobody }));
    expect(out).toContain("Nobody can do this company&#x27;s hiring yet");
    expect(out).toContain("<strong>Fix:</strong>");
    expect(renderToStaticMarkup(createElement(HiringNotice, { hiring: null }))).toBe("");
  });

  it("shows the run profile a role should have, and what a linked agent lacks", () => {
    const role = teamRole("seo-specialist");
    const agent: TeamAgent = { id: "a", name: "SEO Specialist", title: null, role: null, status: "idle", urlKey: null, adapterType: "claude_local", adapterConfig: { instructionsBundleMode: "managed" } };
    const out = renderToStaticMarkup(createElement(RunProfileLine, { state: emptyRoleState(role, { loaded: true, agent }) }));
    expect(out).toContain("Run profile: Sonnet (or deepseek/deepseek-v4-flash-0731 on Hermes)");
    expect(out).toContain("60 min per run · up to 6 at once");
    expect(out).toContain("runs without it (no model pinned (runs on the host default, Opus); no run timeout (0 or unset means unlimited))");
    expect(out).toContain("a plugin cannot change agent settings");
    // Nothing is claimed when the agent's settings were not read.
    const unknown = renderToStaticMarkup(createElement(RunProfileLine, { state: emptyRoleState(role, { loaded: true, agent: { ...agent, adapterConfig: undefined } }) }));
    expect(unknown).not.toContain("runs without it");
    // A pinned agent has no problem.
    const pinned = renderToStaticMarkup(createElement(RunProfileLine, { state: emptyRoleState(role, { loaded: true, agent: { ...agent, adapterConfig: { model: "claude-sonnet-5-5", timeoutSec: 3600, maxTurnsPerRun: 200 } } }) }));
    expect(pinned).not.toContain("runs without it");
  });

  it("words a profile in plain terms", () => {
    expect(modelLabel("claude-sonnet-5-5")).toBe("Sonnet");
    expect(modelLabel("claude-haiku-4-5")).toBe("Haiku");
    expect(modelLabel("claude-fable-5-1")).toBe("Fable");
    expect(modelLabel("something-else")).toBe("something-else");
    expect(runProfileText({ model: "claude-sonnet-5-5", timeoutSec: 5400, maxConcurrentRuns: 1 })).toBe("Sonnet · 90 min per run · up to 1 at once");
    expect(runProfileProblemsFor(null)).toEqual([]);
  });

  it("reads the adapter settings, reporting line and permission from the company agent list", () => {
    const [agent] = parseCompanyAgents([{ id: "a", name: "Kai", title: "App Engineer", role: "engineer", status: "idle", urlKey: "kai", reportsTo: "boss", permissions: { canCreateAgents: false }, adapterType: "claude_local", adapterConfig: { model: "claude-sonnet-5-5" } }]);
    expect(agent).toMatchObject({ reportsTo: "boss", canCreateAgents: false, adapterType: "claude_local", adapterConfig: { model: "claude-sonnet-5-5" } });
    expect(parseCompanyAgents([{ id: "a", name: "Kai" }])[0]).not.toHaveProperty("adapterConfig");
  });

  it("opens the New company section from a link", () => {
    expect(setupFocus("?section=new-company", "")).toEqual({ section: "new-company", anchor: null });
    expect(setupFocus("?section=nope", "")).toEqual({ section: null, anchor: null });
  });
});
