/** PAR-13992: the sign-off delegate may decide safe-autopilot approvals a person otherwise holds; any other agent may not. */
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/config.js", async (orig) => ({ ...(await orig<object>()), loadSeoConfig: vi.fn(async () => ({ config: { signoffDelegateAgentIds: ["rhea-agent"] } })) }));
vi.mock("../src/db.js", async (orig) => ({
  ...(await orig<object>()),
  getOptimization: vi.fn(async () => ({ id: "o1", status: "proposed", sprintId: "s1" })),
  getSprint: vi.fn(async () => ({ id: "s1", autopilotMode: "safe" })),
}));

import { approveOptimization } from "../src/service/optimize.js";
import { decidePlaybookChangeTool } from "../src/service/playbook.js";
import { isSignoffDelegate } from "../src/service/signoff.js";

const env = {
  ctx: { logger: { info: vi.fn() }, db: {} },
  playbooks: { getChange: vi.fn(async () => ({ id: "c1", status: "pending", sprintId: "s1" })) },
} as never;
const agent = (agentId: string) => ({ kind: "agent" as const, agentId, runId: null, responsibleUserId: null });
const REFUSED = /Only a person or the sign-off delegate/;
/** Past the gate the call fails on the bare fake env; what matters is that it is not the gate's refusal. */
const gate = async (call: () => Promise<unknown>) => call().then(() => "ok", (e: Error) => (REFUSED.test(e.message) ? "refused" : "past-gate"));

describe("sign-off delegate gate (safe autopilot)", () => {
  it("isSignoffDelegate is true only for an agent named as a delegate", async () => {
    expect(await isSignoffDelegate(env, "c1", agent("rhea-agent"))).toBe(true);
    expect(await isSignoffDelegate(env, "c1", agent("other-agent"))).toBe(false);
    expect(await isSignoffDelegate(env, "c1", { kind: "user" })).toBe(false);
    expect(await isSignoffDelegate(env, "c1", { kind: "system" })).toBe(false);
  });
  it("approveOptimization: the delegate passes the gate, another agent is refused", async () => {
    expect(await gate(() => approveOptimization(env, "c1", agent("rhea-agent"), { optimizationId: "o1" }))).toBe("past-gate");
    expect(await gate(() => approveOptimization(env, "c1", agent("other-agent"), { optimizationId: "o1" }))).toBe("refused");
  });
  it("decidePlaybookChangeTool: the delegate passes the gate, another agent is refused", async () => {
    expect(await gate(() => decidePlaybookChangeTool(env, "c1", agent("rhea-agent"), { changeId: "c1", decision: "keep" }))).toBe("past-gate");
    expect(await gate(() => decidePlaybookChangeTool(env, "c1", agent("other-agent"), { changeId: "c1", decision: "keep" }))).toBe("refused");
  });
});
