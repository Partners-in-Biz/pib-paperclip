import { afterEach, describe, expect, it, vi } from "vitest";
import { COMPANY_OS_SKILL } from "@partnersinbiz/pib-plugin-kit";
import { SEO_ROLE } from "../src/service/hire.js";
import { SKILL_CANONICAL_KEY, SKILL_SLUG } from "../src/constants.js";
import manifest from "../src/manifest.js";
import { ROLE_SKILLS, ROLE_SKILL_PURPOSE, TEAM_SETUP_HREF, agentProblem, attachIfMissing, attachRoleSkills, roleView, skillNames, stillMissing } from "../src/ui/role-skills.js";

const NOW = Date.parse("2026-09-27T10:00:00.000Z");
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString();

const KEYS = ROLE_SKILLS.map((s) => s.key);
const NAMES = skillNames(ROLE_SKILLS);
const IT = ROLE_SKILLS.length === 1 ? "it" : "them";

type Call = { url: string; method: string; body: unknown };

/** Stubs the host's agent skill endpoints: GET /skills returns `have`; POST /skills/sync answers `syncStatus`. */
function stubHost(have: string[] | "error", syncStatus = 200) {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (method === "GET") {
      if (have === "error") return new Response(JSON.stringify({ error: "Forbidden" }), { status: 403 });
      return new Response(JSON.stringify({ desiredSkills: have }), { status: 200 });
    }
    if (syncStatus !== 200) return new Response(JSON.stringify({ error: "Board access required" }), { status: syncStatus });
    return new Response("{}", { status: 200 });
  });
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe("SEO role skills", () => {
  it("uses the skill key the plugin syncs and the manifest asks for, then the operating manual", () => {
    expect(ROLE_SKILLS).toEqual([{ key: SKILL_CANONICAL_KEY, slug: SKILL_SLUG }, { key: COMPANY_OS_SKILL.key, slug: COMPANY_OS_SKILL.slug }]);
    expect(KEYS).toEqual(["plugin/partnersinbiz-seo/seo-sprint", "plugin/partnersinbiz-cockpit/company-os"]);
    expect(JSON.stringify(manifest)).toContain(KEYS[0]);
    expect(SEO_ROLE.skills.map((s) => s.key)).toEqual(KEYS);
  });
  it("attaches the skill (Attach skills) and says so", async () => {
    const calls = stubHost(["paperclip"]);
    const note = await attachRoleSkills({ agentId: "a1", agentName: "Sam", companyId: "c1", skills: ROLE_SKILLS, purpose: ROLE_SKILL_PURPOSE });
    expect(note).toEqual({ ok: true, line: `Attached ${NAMES} to Sam, so it knows the SEO sprint procedure.` });
    const sync = calls.find((c) => c.method === "POST")!;
    expect(sync.url).toBe("/api/agents/a1/skills/sync?companyId=c1");
    expect(sync.body).toEqual({ mode: "add", desiredSkills: KEYS });
  });

  it("does not re-add a skill the agent already has", async () => {
    const calls = stubHost(KEYS);
    const note = await attachRoleSkills({ agentId: "a1", agentName: "Sam", companyId: "c1", skills: ROLE_SKILLS, purpose: "x" });
    expect(note).toEqual({ ok: true, line: `Sam already has ${NAMES}.` });
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("explains where to add it when the attach fails", async () => {
    stubHost([], 403);
    const note = await attachRoleSkills({ agentId: "a1", agentName: "Sam", companyId: "c1", skills: ROLE_SKILLS, purpose: "x" });
    expect(note.ok).toBe(false);
    expect(note.line).toBe(`Could not attach ${NAMES} to Sam (Board access required). Add ${IT} in Agents → Sam → Skills.`);
  });

  it("attaches a missing skill on page load, and stays quiet when nothing is missing", async () => {
    stubHost([]);
    expect(await attachIfMissing({ agentId: "a1", agentName: "Sam", companyId: "c1", skills: ROLE_SKILLS })).toEqual({ ok: true, line: `Attached ${NAMES} to Sam.` });
    stubHost(KEYS);
    expect(await attachIfMissing({ agentId: "a1", agentName: "Sam", companyId: "c1", skills: ROLE_SKILLS })).toBeNull();
  });

  it("turns a viewer without permission into a note, never an error", async () => {
    stubHost([], 403);
    expect(await attachIfMissing({ agentId: "a1", agentName: "Sam", companyId: "c1", skills: ROLE_SKILLS })).toEqual({ ok: false, line: `Sam is missing ${NAMES}. Add ${IT} in Agents → Sam → Skills.` });
    // Skills unreadable: nothing to say and nothing attempted.
    const calls = stubHost("error");
    expect(await attachIfMissing({ agentId: "a1", agentName: "Sam", companyId: "c1", skills: ROLE_SKILLS })).toBeNull();
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("names several skills in one line", () => {
    expect(skillNames([{ key: "a", slug: "pib-a" }, { key: "b", slug: "pib-b" }])).toBe("the pib-a and pib-b skills");
  });
});

describe("SEO agent box: hire state", () => {
  it("is none with no agent and no open hire task", () => {
    expect(roleView({ agentId: null, hire: null, now: NOW }).mode).toBe("none");
    expect(roleView({ agentId: null, hire: { status: "cancelled", createdAt: daysAgo(1) }, now: NOW }).mode).toBe("none");
  });

  it("is linked once an agent is linked", () => {
    expect(roleView({ agentId: "a1", hire: { status: "open", createdAt: daysAgo(30) }, now: NOW })).toEqual({ mode: "linked", closed: false, stale: false, canRehire: false });
  });

  it("is hiring while a hire task is open; stuck after 7 days or when the task was closed", () => {
    expect(roleView({ agentId: null, hire: { status: "open", createdAt: daysAgo(2), issueStatus: "todo" }, now: NOW })).toEqual({ mode: "hiring", closed: false, stale: false, canRehire: false });
    expect(roleView({ agentId: null, hire: { status: "open", createdAt: daysAgo(8), issueStatus: "in_progress" }, now: NOW })).toEqual({ mode: "hiring", closed: false, stale: true, canRehire: true });
    expect(roleView({ agentId: null, hire: { status: "open", createdAt: daysAgo(1), issueStatus: "done" }, now: NOW })).toEqual({ mode: "hiring", closed: true, stale: false, canRehire: true });
  });
});

describe("SEO agent box: only when something is wrong", () => {
  const sam = (status: string) => ({ name: "Sam", status });

  it("shows nothing while the agent works and has its skill", () => {
    for (const status of ["active", "idle", "running"]) expect(agentProblem({ agent: sam(status), hire: null, now: NOW }), status).toBeNull();
    expect(agentProblem({ agent: sam("idle"), hire: { status: "linked", createdAt: daysAgo(3) }, missingSkills: [], now: NOW })).toBeNull();
  });

  it("no agent and no open hire: one line, fixed in Setup → Team", () => {
    expect(agentProblem({ agent: null, hire: null, now: NOW })).toEqual({ health: "missing", tone: "warn", text: "No SEO agent yet, so SEO tasks wait unassigned.", skills: false });
    expect(agentProblem({ agent: null, hire: { status: "cancelled", createdAt: daysAgo(1) }, now: NOW })?.health).toBe("missing");
    expect(TEAM_SETUP_HREF).toBe("/setup?section=team#team-seo-specialist");
  });

  it("a hire open without an agent", () => {
    const hire = { status: "open", createdAt: daysAgo(2), issueStatus: "todo", identifier: "PIB-12" };
    expect(agentProblem({ agent: null, hire, now: NOW })).toEqual({ health: "hiring", tone: "info", text: "The hire task PIB-12 is open: the new SEO agent is linked as soon as it appears.", skills: false });
    expect(agentProblem({ agent: null, hire: { ...hire, createdAt: daysAgo(9) }, now: NOW })).toMatchObject({ tone: "warn", text: "The hire task PIB-12 has been open for more than 7 days and no SEO agent is linked yet." });
    expect(agentProblem({ agent: null, hire: { ...hire, issueStatus: "done" }, now: NOW })).toMatchObject({ tone: "warn", text: "The hire task PIB-12 was closed, but no SEO agent was linked." });
    expect(agentProblem({ agent: null, hire, candidates: 2, now: NOW })?.text).toBe("More than one new agent looks like the SEO agent: pick the right one in Setup.");
  });

  it("an agent that is paused, in error or waiting for approval", () => {
    expect(agentProblem({ agent: sam("paused"), hire: null, now: NOW })).toEqual({ health: "attention", tone: "warn", text: "Sam is paused, so it does not pick up SEO work.", skills: false });
    expect(agentProblem({ agent: sam("error"), hire: null, now: NOW })).toMatchObject({ tone: "bad", text: "Sam is in error, so it does not pick up SEO work." });
    expect(agentProblem({ agent: sam("pending_approval"), hire: null, now: NOW })?.text).toBe("Sam is waiting for approval: approve the hire, then resume it.");
  });

  it("a missing skill: Attach skills and Re-sync fix it on the page", () => {
    const slugs = ROLE_SKILLS.map((s) => s.slug);
    expect(agentProblem({ agent: sam("idle"), hire: null, missingSkills: slugs, now: NOW })).toEqual({ health: "attention", tone: "warn", text: `Sam is missing ${NAMES}.`, skills: true });
    expect(agentProblem({ agent: sam("paused"), hire: null, missingSkills: slugs, now: NOW })?.text).toBe(`Sam is paused, so it does not pick up SEO work. It is also missing ${NAMES}.`);
  });

  it("counts a skill missing only once the page's own check has run", () => {
    const slugs = ROLE_SKILLS.map((s) => s.slug);
    expect(stillMissing({ checked: false, attached: false, attachFailed: true })).toEqual([]);
    expect(stillMissing({ checked: true, attached: false, attachFailed: true })).toEqual(slugs);
    expect(stillMissing({ checked: true, attached: true, attachFailed: false })).toEqual([]);
    expect(stillMissing({ checked: true, attached: false, attachFailed: false })).toEqual([]);
  });
});
