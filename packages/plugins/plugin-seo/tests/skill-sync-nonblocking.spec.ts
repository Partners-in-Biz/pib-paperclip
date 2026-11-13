import { describe, expect, it, vi } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { SKILL_SYNC_RETRY_MS } from "@partnersinbiz/pib-plugin-kit";
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

  it("after a failed sync a later call leaves the host alone for five minutes, then starts a new sync", async () => {
    const harness = await setup(async () => { throw new Error("timed out"); });
    const reset = (harness.ctx as unknown as { skills: { managed: { reset: ReturnType<typeof vi.fn> } } }).skills.managed.reset;
    const realNow = Date.now.bind(Date);
    let ahead = 0;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => realNow() + ahead);
    try {
      await harness.executeTool("list-sprints", {}, { companyId: "co-1" });
      await new Promise((r) => setTimeout(r, 50));
      const first = reset.mock.calls.length;
      expect(first).toBeGreaterThan(0);
      // A retry on every call only adds load to a host that is already slow (kit `soon`).
      await harness.executeTool("list-sprints", {}, { companyId: "co-1" });
      await new Promise((r) => setTimeout(r, 50));
      expect(reset.mock.calls.length).toBe(first);
      ahead = SKILL_SYNC_RETRY_MS;
      await harness.executeTool("list-sprints", {}, { companyId: "co-1" });
      await new Promise((r) => setTimeout(r, 50));
      expect(reset.mock.calls.length).toBeGreaterThan(first);
    } finally {
      clock.mockRestore();
    }
  });
});
