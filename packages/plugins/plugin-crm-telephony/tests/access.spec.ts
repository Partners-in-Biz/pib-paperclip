import { describe, expect, it } from "vitest";
import { checkVoiceAccess } from "../src/access.js";
import type { PluginApiRequestInput } from "@paperclipai/plugin-sdk";

describe("Voice Access", () => {
  it("refuses agent actor type", () => {
    const actor: PluginApiRequestInput["actor"] = {
      actorType: "agent",
      actorId: "agent-123",
    };
    const result = checkVoiceAccess(actor, ["user-1"]);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(403);
      expect(result.error).toBe("Only a signed-in person can use the dialer");
    }
  });

  it("refuses empty allowlist", () => {
    const actor: PluginApiRequestInput["actor"] = {
      actorType: "user",
      userId: "user-123",
      actorId: "user-123",
    };
    const result = checkVoiceAccess(actor, []);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(403);
      expect(result.error).toBe("Calling is not enabled for any user");
    }
  });

  it("refuses user not in allowlist", () => {
    const actor: PluginApiRequestInput["actor"] = {
      actorType: "user",
      userId: "user-other",
      actorId: "user-other",
    };
    const result = checkVoiceAccess(actor, ["user-1", "user-2"]);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(403);
      expect(result.error).toBe("Calling is not enabled for this user");
    }
  });

  it("allows user in allowlist via userId", () => {
    const actor: PluginApiRequestInput["actor"] = {
      actorType: "user",
      userId: "user-1",
      actorId: "user-123",
    };
    const result = checkVoiceAccess(actor, ["user-1", "user-2"]);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.userId).toBe("user-1");
    }
  });

  it("allows user in allowlist via actorId fallback", () => {
    const actor: PluginApiRequestInput["actor"] = {
      actorType: "user",
      actorId: "user-1",
    };
    const result = checkVoiceAccess(actor, ["user-1", "user-2"]);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.userId).toBe("user-1");
    }
  });

  it("prefers userId over actorId", () => {
    const actor: PluginApiRequestInput["actor"] = {
      actorType: "user",
      userId: "user-preferred",
      actorId: "user-fallback",
    };
    const result = checkVoiceAccess(actor, ["user-preferred"]);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.userId).toBe("user-preferred");
    }
  });

  it("error text never contains allowlist contents", () => {
    const actor: PluginApiRequestInput["actor"] = {
      actorType: "user",
      userId: "user-other",
      actorId: "user-other",
    };
    const allowlist = ["user-secret-1", "user-secret-2"];
    const result = checkVoiceAccess(actor, allowlist);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      const errorText = result.error.toLowerCase();
      expect(errorText).not.toContain("user-secret");
      expect(errorText).not.toContain("user-other");
    }
  });
});
