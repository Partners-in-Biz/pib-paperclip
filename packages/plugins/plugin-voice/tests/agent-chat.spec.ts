import { describe, expect, it, vi } from "vitest";
import { AgentChat, agentRefFromPath, chatBody, defaultAgent, type ApiClient } from "../src/ui/agent-chat.js";
import { plainChatContext, type TaskCallContext } from "../src/ui/call-context.js";
import { buildInstructions } from "../src/ui/live-instructions.js";

const AGENTS = [
  { id: "a-dev", name: "Developer", role: "engineer", status: "idle" },
  { id: "a-old", name: "Old CEO", role: "ceo", status: "terminated" },
  { id: "a-ceo", name: "PiB", role: "ceo", status: "idle" },
];

function fakeApi(overrides: { failComments?: number } = {}) {
  let commentFailures = overrides.failComments ?? 0;
  const get = vi.fn(async (path: string) => {
    if (path === "/companies/c1/agents") return AGENTS;
    throw new Error(`unexpected GET ${path}`);
  });
  const post = vi.fn(async (path: string, _body: unknown) => {
    if (path.startsWith("/companies/c1/chats/")) return { id: "chat-1", identifier: "PAR-1558", assigneeAgentId: "a-ceo" };
    if (path === "/issues/chat-1/comments") {
      if (commentFailures > 0) {
        commentFailures--;
        throw new Error("network");
      }
      return { id: "comment-1" };
    }
    throw new Error(`unexpected POST ${path}`);
  });
  return { api: { get, post } as unknown as ApiClient, get, post };
}

describe("agent chat routing", () => {
  it("reads the agent from an Agent Chat page only", () => {
    expect(agentRefFromPath("/PAR/chats/pib")).toBe("pib");
    expect(agentRefFromPath("/PAR/chats/senior%20dev?x=1")).toBe("senior dev");
    expect(agentRefFromPath("/PAR/issues/PAR-12")).toBeNull();
  });

  it("defaults to the active CEO", () => {
    expect(defaultAgent(AGENTS)?.id).toBe("a-ceo");
    expect(defaultAgent([AGENTS[0]!])?.id).toBe("a-dev");
    expect(defaultAgent([])).toBeNull();
  });

  it("keeps the spoken words and says where they came from", () => {
    const none = { about: null, direct: false, block: null };
    expect(chatBody(" create a task for Kai ", { ...none, about: "from PAR-9" })).toBe("create a task for Kai\n\n_Sent by voice from PAR-9._");
    expect(chatBody("hi", none)).toBe("hi\n\n_Sent by voice._");
    expect(chatBody("hi", { ...none, direct: true })).toBe("hi\n\n_Sent by voice: reply in short spoken sentences._");
    expect(chatBody("hi", { about: "from PAR-9", direct: true, block: null })).toBe("hi\n\n_Sent by voice from PAR-9: reply in short spoken sentences._");
  });

  it("puts the block between the words and the footer", () => {
    expect(chatBody("hi", { about: "about PAR-9", direct: false, block: "BLOCK" })).toBe("hi\n\nBLOCK\n\n_Sent by voice about PAR-9._");
  });

  it("posts each turn as a comment on the agent's chat issue, ensuring the chat once", async () => {
    const { api, post } = fakeApi();
    const chat = new AgentChat({ api, companyId: "c1", agentRef: null, context: plainChatContext() });
    const first = await chat.submit("create a task", "11111111-1111-4111-8111-111111111111");
    await chat.submit("and another", "22222222-2222-4222-8222-222222222222");
    expect(first).toEqual({ issueId: "chat-1", ref: "PAR-1558", agentName: "PiB", agentId: "a-ceo" });
    const chatCalls = post.mock.calls.filter(([p]) => String(p).includes("/chats/"));
    expect(chatCalls).toEqual([["/companies/c1/chats/a-ceo", {}]]);
    const comments = post.mock.calls.filter(([p]) => p === "/issues/chat-1/comments");
    expect(comments.map(([, b]) => b)).toEqual([
      { body: "create a task\n\n_Sent by voice._", clientRequestId: "11111111-1111-4111-8111-111111111111" },
      { body: "and another\n\n_Sent by voice._", clientRequestId: "22222222-2222-4222-8222-222222222222" },
    ]);
  });

  it("uses a named agent from the page as given", async () => {
    const { api, post } = fakeApi();
    const chat = new AgentChat({ api, companyId: "c1", agentRef: "pib", context: plainChatContext() });
    await chat.submit("ping", "33333333-3333-4333-8333-333333333333");
    expect(post.mock.calls[0]).toEqual(["/companies/c1/chats/pib", {}]);
  });

  it("retries a failed chat lookup on the next send", async () => {
    const { api, post } = fakeApi();
    post.mockRejectedValueOnce(new Error("503"));
    const chat = new AgentChat({ api, companyId: "c1", agentRef: "pib", context: plainChatContext() });
    await expect(chat.submit("one", "44444444-4444-4444-8444-444444444444")).rejects.toThrow("503");
    await expect(chat.submit("one", "44444444-4444-4444-8444-444444444444")).resolves.toMatchObject({ issueId: "chat-1" });
  });
});

function taskCtx(over: Partial<TaskCallContext> = {}): TaskCallContext {
  return { kind: "task", agentId: "a-ceo", agentRef: "a-ceo", blockSent: false, notes: [], issueRef: "PAR-9", issueId: "i9", aboutLine: 'about PAR-9: "T"', block: "BLOCK", saveRef: "PAR-9", ...over };
}

describe("task context on the first sent turn", () => {
  const bodies = (post: ReturnType<typeof fakeApi>["post"]) => post.mock.calls.filter(([p]) => p === "/issues/chat-1/comments").map(([, b]) => (b as { body: string }).body);

  it("carries the block once, then only the about line", async () => {
    const { api, post } = fakeApi();
    const context = taskCtx();
    const chat = new AgentChat({ api, companyId: "c1", agentRef: "a-ceo", context });
    await chat.submit("one", "11111111-1111-4111-8111-111111111111");
    await chat.submit("two", "22222222-2222-4222-8222-222222222222");
    const [first, second] = bodies(post);
    expect(first).toBe('one\n\nBLOCK\n\n_Sent by voice about PAR-9: "T"._');
    expect(second).toBe('two\n\n_Sent by voice about PAR-9: "T"._');
    expect(context.blockSent).toBe(true);
  });

  it("sets blockSent only when a POST returns a row, and a new AgentChat on the same context does not resend", async () => {
    const { api, post } = fakeApi({ failComments: 1 });
    const context = taskCtx();
    const chat = new AgentChat({ api, companyId: "c1", agentRef: "a-ceo", context });
    await expect(chat.submit("one", "11111111-1111-4111-8111-111111111111")).rejects.toThrow("network");
    expect(context.blockSent).toBe(false);
    await chat.submit("one", "11111111-1111-4111-8111-111111111111");
    expect(context.blockSent).toBe(true);
    const switched = new AgentChat({ api, companyId: "c1", agentRef: "a-ceo", context });
    await switched.submit("again", "33333333-3333-4333-8333-333333333333");
    const sent = bodies(post);
    expect(sent[1]).toContain("BLOCK");
    expect(sent[2]).not.toContain("BLOCK");
  });

  it("never carries a block on a chat", async () => {
    const { api, post } = fakeApi();
    await new AgentChat({ api, companyId: "c1", agentRef: "pib", context: plainChatContext("pib") }).submit("hi", "44444444-4444-4444-8444-444444444444");
    expect(bodies(post)[0]).toBe("hi\n\n_Sent by voice._");
  });
});

describe("chat route 404 fallback", () => {
  it("falls back to the default agent once and says who was unreachable", async () => {
    const { api, post } = fakeApi();
    post.mockImplementationOnce(async () => {
      throw Object.assign(new Error("Agent not found"), { status: 404 });
    });
    const chat = new AgentChat({ api, companyId: "c1", agentRef: "a-dev", context: plainChatContext("a-dev") });
    const target = await chat.resolve();
    expect(post.mock.calls.filter(([p]) => String(p).includes("/chats/")).map(([p]) => p)).toEqual(["/companies/c1/chats/a-dev", "/companies/c1/chats/a-ceo"]);
    expect(target.agentName).toBe("PiB");
    expect(target.fellBack).toEqual({ from: "Developer" });
  });

  it("does not fall back on other errors, or when the default agent itself is missing", async () => {
    const { api, post } = fakeApi();
    post.mockRejectedValueOnce(Object.assign(new Error("boom"), { status: 500 }));
    await expect(new AgentChat({ api, companyId: "c1", agentRef: "a-dev", context: plainChatContext("a-dev") }).resolve()).rejects.toThrow("boom");
    post.mockRejectedValueOnce(Object.assign(new Error("Agent not found"), { status: 404 }));
    await expect(new AgentChat({ api, companyId: "c1", agentRef: "a-ceo", context: plainChatContext("a-ceo") }).resolve()).rejects.toThrow("Agent not found");
  });
});

describe("live instructions", () => {
  it("make the voice a relay, not a second agent with its own tools", () => {
    const text = buildInstructions({ personName: "Peet", companyName: "Partners in Biz", pageIssueRef: "PAR-12", now: new Date("2026-10-25T10:00:00Z") });
    expect(text).toContain("PAR-12");
    expect(text).toContain("Partners in Biz");
    expect(text).toContain("passed automatically");
    expect(text).toContain("[Update]");
    expect(text).toContain("[Status]");
    expect(text).not.toContain("confirmationId");
    expect(text).not.toMatch(/call (them|the tools)/i);
  });
});

describe("voice comment field", () => {
  const VOICE = { version: 1, voice: { mode: "direct" }, sections: [] };
  function api(health: () => Promise<unknown>) {
    const post = vi.fn(async (path: string, _body: unknown) => (path.startsWith("/companies/") ? { id: "chat-1", assigneeAgentId: "a-ceo" } : { id: "c1" }));
    const get = vi.fn(async (path: string) => (path === "/health" ? health() : AGENTS));
    return { api: { get, post } as unknown as ApiClient, post, get };
  }
  const commentBody = (post: ReturnType<typeof api>["post"]) => post.mock.calls.find((c) => c[0] === "/issues/chat-1/comments")![1] as Record<string, unknown>;
  const ok = async () => ({ status: "ok", capabilities: { voiceCommentMetadata: 1 } });

  it("marks a Direct spoken turn when the server reports the capability, and keeps the footer", async () => {
    const a = api(ok);
    await new AgentChat({ api: a.api, companyId: "c1", agentRef: null, context: plainChatContext(), direct: true }).post("hi", "id-1");
    expect(commentBody(a.post).metadata).toEqual(VOICE);
    expect(String(commentBody(a.post).body)).toContain("_Sent by voice");
  });

  it("posts as before when the capability is absent or the health read fails", async () => {
    for (const health of [async () => ({ status: "ok" }), async () => { throw new Error("down"); }, async () => null]) {
      const a = api(health);
      await new AgentChat({ api: a.api, companyId: "c1", agentRef: null, context: plainChatContext(), direct: true }).post("hi", "id-1");
      expect("metadata" in commentBody(a.post)).toBe(false);
    }
  });

  it("never marks a typed or classic turn, and reads health once per call", async () => {
    const a = api(ok);
    const classic = new AgentChat({ api: a.api, companyId: "c1", agentRef: null, context: plainChatContext() });
    await classic.post("hi", "id-1");
    expect("metadata" in commentBody(a.post)).toBe(false);
    expect(a.get.mock.calls.some((c) => c[0] === "/health")).toBe(false);
    const b = api(ok);
    const direct = new AgentChat({ api: b.api, companyId: "c1", agentRef: null, context: plainChatContext(), direct: true });
    await direct.post("one", "id-2");
    await direct.post("two", "id-3");
    expect(b.get.mock.calls.filter((c) => c[0] === "/health")).toHaveLength(1);
  });
});
