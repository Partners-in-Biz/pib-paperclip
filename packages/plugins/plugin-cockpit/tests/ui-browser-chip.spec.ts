import { describe, expect, it } from "vitest";
import { pickSession } from "../src/ui/browser-live-chip.js";

const a = { agentId: "a1", identity: "pib:meta", issue: "PAR-1" };
const b = { agentId: "a2", identity: "pib:paperclip", issue: "PAR-2" };

describe("pickSession", () => {
  it("matches the issue the agent works on", () => expect(pickSession([a, b], { identifier: "PAR-2", conversationAgentId: null })).toBe(b));
  it("falls back to the chat agent", () => expect(pickSession([a, b], { identifier: "PAR-9", conversationAgentId: "a1" })).toBe(a));
  it("is null with no match or no issue", () => {
    expect(pickSession([a], { identifier: "PAR-9", conversationAgentId: null })).toBeNull();
    expect(pickSession([a], null)).toBeNull();
  });
});
