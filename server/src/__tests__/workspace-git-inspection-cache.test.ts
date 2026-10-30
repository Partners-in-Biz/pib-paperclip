import type { ExecutionWorkspace } from "@paperclipai/shared";
import { afterEach, expect, it, vi } from "vitest";
import { createWorkspaceGitInspectionCache } from "../services/workspace-git-inspection-cache.js";

const workspace = { id: "workspace", companyId: "company", cwd: "/repo", baseRef: "master" } as ExecutionWorkspace;
afterEach(() => vi.useRealTimers());

it("coalesces concurrent display reads and expires after five seconds", async () => {
  vi.useFakeTimers();
  const inspect = vi.fn(async () => ({ dirty: false }));
  const read = createWorkspaceGitInspectionCache(inspect);
  await Promise.all(Array.from({ length: 100 }, () => read(workspace)));
  expect(inspect).toHaveBeenCalledTimes(1);
  await read(workspace);
  expect(inspect).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(5_000);
  await read(workspace);
  expect(inspect).toHaveBeenCalledTimes(2);
  // Callers that authorize cleanup retain the uncached inspector.
  await inspect();
  expect(inspect).toHaveBeenCalledTimes(3);
});

it("does not share results across companies, paths, base refs or workspace revisions", async () => {
  const inspect = vi.fn(async () => null);
  const read = createWorkspaceGitInspectionCache(inspect);
  await read(workspace);
  await read({ ...workspace, companyId: "other" });
  await read({ ...workspace, cwd: "/other" });
  await read({ ...workspace, baseRef: "other" });
  await read({ ...workspace, updatedAt: new Date() });
  expect(inspect).toHaveBeenCalledTimes(5);
});

it("retries failed inspections and bounds retained entries", async () => {
  const inspect = vi.fn(async () => null).mockRejectedValueOnce(new Error("failed"));
  const read = createWorkspaceGitInspectionCache(inspect);
  await expect(read(workspace)).rejects.toThrow("failed");
  await read(workspace);
  expect(inspect).toHaveBeenCalledTimes(2);
  for (let i = 0; i < 256; i++) await read({ ...workspace, id: String(i) });
  await read(workspace);
  expect(inspect).toHaveBeenCalledTimes(259);
});

it("serves a 30s sweep TTL, shares in-flight calls, and expires", async () => {
  let clock = 1_000;
  const inspect = vi.fn(async () => ({ statusInspectionSucceeded: true }));
  const read = createWorkspaceGitInspectionCache(inspect, { ttlMs: 30_000, now: () => clock });
  await Promise.all(Array.from({ length: 117 }, () => read(workspace)));
  expect(inspect).toHaveBeenCalledTimes(1);
  clock += 29_999;
  await read(workspace);
  expect(inspect).toHaveBeenCalledTimes(1);
  clock += 1;
  await read(workspace);
  expect(inspect).toHaveBeenCalledTimes(2);
});

it("does not retain results rejected by shouldRetain and honours maxEntries", async () => {
  const inspect = vi.fn(async () => ({ ok: false }));
  const read = createWorkspaceGitInspectionCache(inspect, { shouldRetain: (r) => r.ok, maxEntries: 2 });
  await Promise.all([read(workspace), read(workspace)]);
  expect(inspect).toHaveBeenCalledTimes(1);
  await read(workspace);
  expect(inspect).toHaveBeenCalledTimes(2);

  const okInspect = vi.fn(async () => ({ ok: true }));
  const bounded = createWorkspaceGitInspectionCache(okInspect, { maxEntries: 2 });
  await bounded({ ...workspace, id: "a" });
  await bounded({ ...workspace, id: "b" });
  await bounded({ ...workspace, id: "c" });
  await bounded({ ...workspace, id: "a" });
  expect(okInspect).toHaveBeenCalledTimes(4);
});
