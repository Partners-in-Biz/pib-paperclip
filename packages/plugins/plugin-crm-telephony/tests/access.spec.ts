import { describe, expect, it } from "vitest";
import { checkVoiceAccess } from "../src/access.js";
import type { PluginApiRequestInput } from "@paperclipai/plugin-sdk";

describe("Voice Access", () => {
  it("refuses agent actor", () => {
    const actor: PluginApiRequestInput["actor"] = { actorType: "agent", actorId: "agent-1" };
    const result = checkVoiceAccess(actor, ["user-1"]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(403);
  });

  it("refuses empty allowlist", () => {
    const actor: PluginApiRequestInput["actor"] = { actorType: "user", userId: "u1", actorId: "u1" };
    const result = checkVoiceAccess(actor, []);
    expect(result.ok).toBe(false);
  });

  it("refuses user not in allowlist", () => {
    const actor: PluginApiRequestInput["actor"] = { actorType: "user", userId: "other", actorId: "other" };
    const result = checkVoiceAccess(actor, ["user-1", "user-2"]);
    expect(result.ok).toBe(false);
  });

  it.each([
    ["via userId", { actorType: "user" as const, userId: "user-1", actorId: "u123" }, "user-1"],
    ["via actorId", { actorType: "user" as const, actorId: "user-1" }, "user-1"],
    ["userId over actorId", { actorType: "user" as const, userId: "user-pref", actorId: "user-fallback" }, "user-pref"],
  ])("allows allowlisted user %s", (_desc, actor, expectedId) => {
    const result = checkVoiceAccess(actor as PluginApiRequestInput["actor"], [expectedId]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.userId).toBe(expectedId);
  });
});
