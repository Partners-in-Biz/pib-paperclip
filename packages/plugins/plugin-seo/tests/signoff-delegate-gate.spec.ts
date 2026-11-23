/** PAR-13992: the sign-off delegate may decide safe-autopilot approvals a person otherwise holds; any other agent may not. */
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/config.js", async (orig) => ({ ...(await orig<object>()), loadSeoConfig: vi.fn(async () => ({ config: { signoffDelegateAgentIds: ["rhea-agent"] } })) }));

import { isSignoffDelegate } from "../src/service/signoff.js";

const env = { ctx: { logger: { info: vi.fn() } } } as never;

describe("isSignoffDelegate", () => {
  it("is true only for an agent named as a sign-off delegate", async () => {
    expect(await isSignoffDelegate(env, "c1", { kind: "agent", agentId: "rhea-agent" })).toBe(true);
    expect(await isSignoffDelegate(env, "c1", { kind: "agent", agentId: "other-agent" })).toBe(false);
    expect(await isSignoffDelegate(env, "c1", { kind: "user" })).toBe(false);
    expect(await isSignoffDelegate(env, "c1", { kind: "system" })).toBe(false);
  });
});
