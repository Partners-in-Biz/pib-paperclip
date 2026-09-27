import { afterEach, describe, expect, it, vi } from "vitest";
import { DESIRED_SKILLS, SKILLS } from "../src/skills.js";
import { SOCIAL_HIRE_ROLE } from "../src/hire.js";
import { ROLE_SKILLS, ROLE_SKILL_PURPOSE, attachIfMissing, attachOnLink, dropSkillAsks, roleView, skillNames } from "../src/ui/role-skills.js";

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

describe("Social role skills", () => {
  it("uses the skill keys the manifest and the hire role ask for", () => {
    expect(KEYS).toEqual(["plugin/partnersinbiz-social/social-publish", "plugin/partnersinbiz-social/social-content"]);
    expect(KEYS).toEqual(DESIRED_SKILLS);
    expect(ROLE_SKILLS.map((s) => s.slug)).toEqual(SKILLS.map((s) => s.slug));
    expect(SOCIAL_HIRE_ROLE.skills.map((s) => s.key)).toEqual(KEYS);
  });
  it("attaches the skill after a manual link and says so", async () => {
    const calls = stubHost(["paperclip"]);
    const note = await attachOnLink({ agentId: "a1", agentName: "Sam", companyId: "c1", skills: ROLE_SKILLS, purpose: ROLE_SKILL_PURPOSE });
    expect(note).toEqual({ ok: true, line: `Attached ${NAMES} to Sam, so it knows how to use the Social tools.` });
    const sync = calls.find((c) => c.method === "POST")!;
    expect(sync.url).toBe("/api/agents/a1/skills/sync?companyId=c1");
    expect(sync.body).toEqual({ mode: "add", desiredSkills: KEYS });
  });

  it("does not re-add a skill the agent already has", async () => {
    const calls = stubHost(KEYS);
    const note = await attachOnLink({ agentId: "a1", agentName: "Sam", companyId: "c1", skills: ROLE_SKILLS, purpose: "x" });
    expect(note).toEqual({ ok: true, line: `Sam already has ${NAMES}.` });
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("explains where to add it when the attach fails", async () => {
    stubHost([], 403);
    const note = await attachOnLink({ agentId: "a1", agentName: "Sam", companyId: "c1", skills: ROLE_SKILLS, purpose: "x" });
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

  it("drops the worker's attach-by-hand lines once the page attached the skills", () => {
    const slug = ROLE_SKILLS[0]!.slug;
    const lines = [`Synced the \`${slug}\` skill to its latest version.`, `Attach the \`${slug}\` skill to Sam (Agents → Sam → Skills). The plugin cannot attach it.`, `Sam does not have \`${slug}\` yet.`, "Granted plugin tool access."];
    expect(dropSkillAsks(lines, ROLE_SKILLS)).toEqual([lines[0], "Granted plugin tool access."]);
  });

  it("names several skills in one line", () => {
    expect(skillNames([{ key: "a", slug: "pib-a" }, { key: "b", slug: "pib-b" }])).toBe("the pib-a and pib-b skills");
  });
});

describe("Social agent card: Hire Social agent button", () => {
  it("shows Hire Social agent only with no agent and no open hire task", () => {
    expect(roleView({ agentId: null, hire: null, now: NOW }).mode).toBe("none");
    expect(roleView({ agentId: null, hire: { status: "cancelled", createdAt: daysAgo(1) }, now: NOW }).mode).toBe("none");
  });

  it("hides it once an agent is linked", () => {
    expect(roleView({ agentId: "a1", hire: { status: "open", createdAt: daysAgo(30) }, now: NOW })).toEqual({ mode: "linked", closed: false, stale: false, canRehire: false });
  });

  it("hides it while a hire task is open, offering a new hire only after 7 days or when the task was closed", () => {
    expect(roleView({ agentId: null, hire: { status: "open", createdAt: daysAgo(2), issueStatus: "todo" }, now: NOW })).toEqual({ mode: "hiring", closed: false, stale: false, canRehire: false });
    expect(roleView({ agentId: null, hire: { status: "open", createdAt: daysAgo(8), issueStatus: "in_progress" }, now: NOW })).toEqual({ mode: "hiring", closed: false, stale: true, canRehire: true });
    expect(roleView({ agentId: null, hire: { status: "open", createdAt: daysAgo(1), issueStatus: "done" }, now: NOW })).toEqual({ mode: "hiring", closed: true, stale: false, canRehire: true });
  });
});
