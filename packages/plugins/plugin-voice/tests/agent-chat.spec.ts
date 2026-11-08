import { describe, expect, it, vi } from "vitest";
import { AgentChat, agentRefFromPath, chatBody, defaultAgent, type ApiClient } from "../src/ui/agent-chat.js";
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
    expect(chatBody(" create a task for Kai ", "PAR-9")).toBe("create a task for Kai\n\n_Sent by voice from PAR-9._");
    expect(chatBody("hi", null)).toBe("hi\n\n_Sent by voice._");
  });

  it("posts each turn as a comment on the agent's chat issue, ensuring the chat once", async () => {
    const { api, post } = fakeApi();
    const chat = new AgentChat({ api, companyId: "c1", agentRef: null, pageIssueRef: null });
    const first = await chat.submit("create a task", "11111111-1111-4111-8111-111111111111");
    await chat.submit("and another", "22222222-2222-4222-8222-222222222222");
    expect(first).toEqual({ issueId: "chat-1", ref: "PAR-1558", agentName: "PiB" });
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
    const chat = new AgentChat({ api, companyId: "c1", agentRef: "pib", pageIssueRef: null });
    await chat.submit("ping", "33333333-3333-4333-8333-333333333333");
    expect(post.mock.calls[0]).toEqual(["/companies/c1/chats/pib", {}]);
  });

  it("retries a failed chat lookup on the next send", async () => {
    const { api, post } = fakeApi();
    post.mockRejectedValueOnce(new Error("503"));
    const chat = new AgentChat({ api, companyId: "c1", agentRef: "pib", pageIssueRef: null });
    await expect(chat.submit("one", "44444444-4444-4444-8444-444444444444")).rejects.toThrow("503");
    await expect(chat.submit("one", "44444444-4444-4444-8444-444444444444")).resolves.toMatchObject({ issueId: "chat-1" });
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
