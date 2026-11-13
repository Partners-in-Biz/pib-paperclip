import { describe, expect, it, vi } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";

// PAR-11023: tools must never wait on the managed-skill sync.
async function setup(reconcile: () => Promise<unknown>) {
  const harness = createTestHarness({ manifest, config: { timezone: "Africa/Johannesburg" } });
  harness.seed({ companies: [{ id: "co-1", issuePrefix: "PIB", name: "PiB" } as never] });
  (harness.ctx as unknown as { skills: unknown }).skills = { managed: { get: vi.fn(async () => null), reconcile: vi.fn(reconcile), reset: vi.fn(reconcile) } };
  await plugin.definition.setup(harness.ctx);
  return harness;
}

describe("tool path does not wait on the skill sync", () => {
  it("list-sprints returns while skills.managed.reconcile never resolves", async () => {
    const harness = await setup(() => new Promise(() => {}));
    const res = await Promise.race([
      harness.executeTool<{ data?: unknown }>("list-sprints", {}, { companyId: "co-1" }),
      new Promise<"hung">((r) => setTimeout(() => r("hung"), 3000)),
    ]);
    expect(res).not.toBe("hung");
    expect((res as { data?: unknown }).data).toBeTypeOf("object");
  });

  it("a later call starts a new sync after a failed one", async () => {
    const harness = await setup(async () => { throw new Error("timed out"); });
    const reconcile = (harness.ctx as unknown as { skills: { managed: { reset: ReturnType<typeof vi.fn> } } }).skills.managed.reset;
    await harness.executeTool("list-sprints", {}, { companyId: "co-1" });
    await new Promise((r) => setTimeout(r, 50));
    const first = reconcile.mock.calls.length;
    expect(first).toBeGreaterThan(0);
    await harness.executeTool("list-sprints", {}, { companyId: "co-1" });
    await new Promise((r) => setTimeout(r, 50));
    expect(reconcile.mock.calls.length).toBeGreaterThan(first);
  });
});
