/**
 * PAR-8999: Velox and Lumen are CRM companies with a typed `social` project link (and a platform one);
 * their Social issues open in that project. Partners in Biz itself (no scope) and a client with no
 * social link keep the shared Social project.
 */
import { describe, expect, it, vi } from "vitest";
import { projectIdFor } from "../src/issues.js";

const VELOX = { kind: "company" as const, id: "2dd7d1e7-3c55-46a0-a169-30fcdb496625" };
const LUMEN = { kind: "company" as const, id: "24429b66-6320-4b38-812c-b8a8a23ceed2" };
const SHARED = "3bd14331-shared";
const stored: Record<string, unknown> = {
  [`client-projects:company:${VELOX.id}`]: { projectIds: ["velox-platform", "1e3d5616-velox-social"], projects: [{ projectId: "velox-platform", kind: "platform" }, { projectId: "1e3d5616-velox-social", kind: "social" }], updatedAt: "2026-11-10T00:00:00Z" },
  [`client-projects:company:${LUMEN.id}`]: { projectIds: ["e617e302-lumen-social"], projects: [{ projectId: "e617e302-lumen-social", kind: "social" }], updatedAt: "2026-11-10T00:00:00Z" },
};
const ctx = {
  logger: { info: vi.fn() },
  state: { get: vi.fn(async (k: { stateKey: string }) => stored[k.stateKey] ?? null) },
  projects: { managed: { get: vi.fn(async () => ({ projectId: SHARED })) }, get: vi.fn(async (id: string) => ({ id, archivedAt: null })) },
} as never;

describe("own brands route to their own Social project", () => {
  it("Velox and Lumen open in their own social project, not the platform link or the shared one", async () => {
    expect(await projectIdFor(ctx, "co", VELOX)).toBe("1e3d5616-velox-social");
    expect(await projectIdFor(ctx, "co", LUMEN)).toBe("e617e302-lumen-social");
  });
  it("Partners in Biz (no scope) and an unlinked client keep the shared Social project", async () => {
    expect(await projectIdFor(ctx, "co", null)).toBe(SHARED);
    expect(await projectIdFor(ctx, "co", { kind: "company", id: "other" })).toBe(SHARED);
  });
});
