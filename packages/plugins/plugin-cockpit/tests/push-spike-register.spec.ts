import { describe, expect, it } from "vitest";
import { registerCockpit } from "../src/register.js";
import { fakeCtx } from "./helpers/fake-ctx.js";

describe("Push spike actions registration", () => {
  it("registers cockpit.pushSpike.publicKey action", () => {
    const fake = fakeCtx();
    registerCockpit(fake.ctx);

    expect(fake.actions.has("cockpit.pushSpike.publicKey")).toBe(true);
  });

  it("registers cockpit.pushSpike.subscribe action", () => {
    const fake = fakeCtx();
    registerCockpit(fake.ctx);

    expect(fake.actions.has("cockpit.pushSpike.subscribe")).toBe(true);
  });

  it("registers cockpit.pushSpike.send action", () => {
    const fake = fakeCtx();
    registerCockpit(fake.ctx);

    expect(fake.actions.has("cockpit.pushSpike.send")).toBe(true);
  });

  it("cockpit.pushSpike.publicKey returns publicKey only", async () => {
    const fake = fakeCtx();
    registerCockpit(fake.ctx);

    const action = fake.actions.get("cockpit.pushSpike.publicKey")!;
    const context = { actor: { type: "user", userId: "test-user-1" } };

    const result = (await action({}, context)) as Record<string, unknown>;

    expect(result).toHaveProperty("publicKey");
    expect(result.publicKey).toBeTruthy();
    expect(typeof result.publicKey).toBe("string");
    expect(result).not.toHaveProperty("privateKey");
  });

  it("cockpit.pushSpike.publicKey returns same key on second call", async () => {
    const fake = fakeCtx();
    registerCockpit(fake.ctx);

    const action = fake.actions.get("cockpit.pushSpike.publicKey")!;
    const context = { actor: { type: "user", userId: "test-user-1" } };

    const result1 = (await action({}, context)) as Record<string, unknown>;
    const result2 = (await action({}, context)) as Record<string, unknown>;

    expect(result1.publicKey).toBe(result2.publicKey);
  });

  it("cockpit.pushSpike.publicKey throws if not a user", async () => {
    const fake = fakeCtx();
    registerCockpit(fake.ctx);

    const action = fake.actions.get("cockpit.pushSpike.publicKey")!;
    const context = { actor: { type: "agent", userId: null } };

    await expect(action({}, context)).rejects.toThrow();
  });
});
