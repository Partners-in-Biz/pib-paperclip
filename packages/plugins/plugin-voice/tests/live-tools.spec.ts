import { describe, expect, it, vi } from "vitest";
import { clip, LiveTools, matchByName, TOOL_DEFINITIONS, type ApiClient } from "../src/ui/live-tools.js";
import { buildInstructions } from "../src/ui/live-instructions.js";
import { floatToPcm16, level, pcm16ToFloat, resample } from "../src/ui/audio.js";
import { formatElapsed, pickRecordingType } from "../src/ui/recorder.js";

const COMPANY = "c1";
const AGENTS = [
  { id: "a-seo", name: "SEO Specialist", title: "SEO", status: "active" },
  { id: "a-kai", name: "Kai", title: "Senior Developer", status: "active" },
  { id: "a-pib", name: "PiB", title: "COO", status: "active" },
];
const ISSUE = { id: "i-1", identifier: "PAR-12", title: "Hunt and Gun rankings", status: "in_progress", assigneeAgentId: "a-seo", priority: "high", description: "Check the rankings" };

function fakeApi(overrides: Partial<Record<string, unknown>> = {}) {
  const get = vi.fn(async (path: string) => {
    if (path in overrides) return overrides[path];
    if (path === `/companies/${COMPANY}/agents`) return AGENTS;
    if (path.startsWith("/issues/PAR-12") || path.startsWith("/issues/i-1?")) return ISSUE;
    if (path.startsWith("/issues/i-1/comments")) {
      return [
        { id: "m2", body: "Rankings are   up", authorAgentId: "a-seo", createdAt: "2026-10-25T10:01:00Z" },
        { id: "m1", body: "How are rankings?", authorUserId: "u1", createdAt: "2026-10-25T10:00:00Z" },
      ];
    }
    if (path.startsWith(`/companies/${COMPANY}/issues?`)) return [ISSUE];
    if (path === `/companies/${COMPANY}/projects`) return [{ id: "p1", name: "Hunt and Gun" }, { id: "p2", name: "PiB Platform", archivedAt: null }];
    throw new Error(`unexpected GET ${path}`);
  });
  const post = vi.fn(async (path: string, body: unknown) => {
    if (path === `/companies/${COMPANY}/issues`) return { id: "i-new", identifier: "PAR-99", ...(body as object) };
    return { id: "c-new" };
  });
  return { api: { get, post } as unknown as ApiClient, get, post };
}

function tools(pageIssueRef: string | null = null, api = fakeApi()) {
  const watch = vi.fn();
  return { t: new LiveTools({ api: api.api, companyId: COMPANY, userId: "u1", pageIssueRef, watch }), watch, ...api };
}

describe("tool definitions", () => {
  it("are valid function tools with unique names", () => {
    const names = TOOL_DEFINITIONS.map((d) => d.name);
    expect(new Set(names).size).toBe(names.length);
    for (const def of TOOL_DEFINITIONS) {
      expect(def.type).toBe("function");
      expect(def.parameters.type).toBe("object");
    }
  });
});

describe("matchByName", () => {
  it("matches loose spoken names", () => {
    expect(matchByName(AGENTS, "seo specialist")?.id).toBe("a-seo");
    expect(matchByName(AGENTS, "the SEO guy")?.id).toBe("a-seo");
    expect(matchByName(AGENTS, "kai")?.id).toBe("a-kai");
    expect(matchByName(AGENTS, "Bookkeeper")).toBeNull();
    expect(matchByName(AGENTS, "")).toBeNull();
  });
});

describe("reading", () => {
  it("summarises the task on screen with its messages oldest first", async () => {
    const { t } = tools("PAR-12");
    const out = (await t.run("get_page_context", {})) as { ref: string; assignee: string; messages: Array<{ from: string; text: string }> };
    expect(out.ref).toBe("PAR-12");
    expect(out.assignee).toBe("SEO Specialist");
    expect(out.messages.map((m) => m.from)).toEqual(["you", "SEO Specialist"]);
    expect(out.messages[1]!.text).toBe("Rankings are up");
  });

  it("says when no task is on screen", async () => {
    const { t } = tools(null);
    expect(await t.run("get_page_context", {})).toMatchObject({ onScreen: "no task open" });
  });

  it("finds tasks by agent name and 'open' status", async () => {
    const { t, get } = tools();
    await t.run("find_tasks", { query: "rankings", status: "open", agent: "seo" });
    const path = get.mock.calls.map((c) => c[0]).find((p) => p.startsWith(`/companies/${COMPANY}/issues?`))!;
    const params = new URL(`http://x${path}`).searchParams;
    expect(params.get("q")).toBe("rankings");
    expect(params.get("status")).toBe("backlog,todo,in_progress,in_review,blocked");
    expect(params.get("assigneeAgentId")).toBe("a-seo");
    expect(params.get("sortField")).toBe("updated");
  });

  it("lists the agents it knows when a name does not match", async () => {
    const { t } = tools();
    expect(await t.run("find_tasks", { agent: "Bookkeeper" })).toMatchObject({ agents: ["SEO Specialist", "Kai", "PiB"] });
  });

  it("asks the server for the person's own open tasks", async () => {
    const { t, get } = tools();
    await t.run("what_needs_me", {});
    expect(get.mock.calls.some((c) => String(c[0]).includes("assigneeUserId=me"))).toBe(true);
  });
});

describe("changes need a spoken yes", () => {
  it("post_message previews first and posts only when confirmed", async () => {
    const { t, post, watch } = tools("PAR-12");
    const preview = (await t.run("post_message", { text: "Send me the numbers" })) as { needsConfirmation: boolean; readBack: string };
    expect(preview.needsConfirmation).toBe(true);
    expect(preview.readBack).toContain("SEO Specialist");
    expect(post).not.toHaveBeenCalled();

    const done = await t.run("post_message", { text: "Send me the numbers", confirmed: true });
    expect(done).toMatchObject({ posted: true, task: "PAR-12", wakes: "SEO Specialist" });
    expect(post).toHaveBeenCalledWith("/issues/i-1/comments", expect.objectContaining({ body: "Send me the numbers" }));
    expect(watch).toHaveBeenCalledWith("i-1", "PAR-12");
  });

  it("post_message needs a task when none is on screen", async () => {
    const { t } = tools(null);
    await expect(t.run("post_message", { text: "hi", confirmed: true })).rejects.toThrow(/Which task/);
  });

  it("create_task previews, then creates assigned to the matched agent and project", async () => {
    const { t, post, watch } = tools();
    const preview = await t.run("create_task", { title: "Fix the sitemap", agent: "kai", project: "hunt and gun" });
    expect(preview).toMatchObject({ needsConfirmation: true });
    expect(post).not.toHaveBeenCalled();

    const created = await t.run("create_task", { title: "Fix the sitemap", agent: "kai", project: "hunt and gun", description: "It 404s", confirmed: true });
    expect(created).toMatchObject({ created: true, task: "PAR-99", assignee: "Kai" });
    expect(post).toHaveBeenCalledWith(
      `/companies/${COMPANY}/issues`,
      expect.objectContaining({ title: "Fix the sitemap", status: "todo", assigneeAgentId: "a-kai", projectId: "p1" }),
    );
    expect(watch).toHaveBeenCalledWith("i-new", "PAR-99");
  });

  it("create_task refuses an unknown agent", async () => {
    const { t, post } = tools();
    expect(await t.run("create_task", { title: "x", agent: "nobody", confirmed: true })).toMatchObject({ error: expect.stringContaining("nobody") });
    expect(post).not.toHaveBeenCalled();
  });
});

describe("instructions", () => {
  it("name the task on screen and the confirmation rule", () => {
    const text = buildInstructions({ personName: "Peet", companyName: "Partners in Biz", pageIssueRef: "PAR-12", now: new Date("2026-10-25T10:00:00Z") });
    expect(text).toContain("PAR-12");
    expect(text).toContain("Partners in Biz");
    expect(text).toContain("confirmed true");
    expect(text).toContain("[Update]");
  });
});

describe("helpers", () => {
  it("clips long text on whitespace-collapsed content", () => {
    expect(clip("a   b")).toBe("a b");
    expect(clip("x".repeat(20), 10)).toBe(`${"x".repeat(9)}…`);
    expect(clip(null)).toBe("");
  });

  it("round-trips PCM16 and resamples 48k to 24k", () => {
    const input = new Float32Array([0, 0.5, -0.5, 1, -1]);
    const back = pcm16ToFloat(floatToPcm16(input));
    back.forEach((v, i) => expect(v).toBeCloseTo(input[i]!, 3));
    expect(resample(new Float32Array(4800), 48_000, 24_000)).toHaveLength(2400);
    expect(resample(input, 24_000, 24_000)).toBe(input);
    expect(level(new Float32Array(10))).toBe(0);
  });

  it("picks mp4 first for iPhone, then webm", () => {
    expect(pickRecordingType((t) => t === "audio/mp4" || t.startsWith("audio/webm"))).toBe("audio/mp4");
    expect(pickRecordingType((t) => t.startsWith("audio/webm"))).toBe("audio/webm;codecs=opus");
    expect(pickRecordingType(() => false)).toBeNull();
    expect(formatElapsed(65_400)).toBe("1:05");
  });
});
