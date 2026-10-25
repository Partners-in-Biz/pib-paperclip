import { describe, expect, it } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { OWN_SKILL_KEY, SKILL_KEY } from "../src/constants.js";
import manifest, { PIB_ONLY_SKILLS } from "../src/manifest.js";
import { createSkillSyncers } from "../src/service/common.js";

const PREFIXES: Record<string, string> = { par: "PAR", client: "ACM" };

function stubCtx() {
  const resets: Array<{ key: string; companyId: string }> = [];
  const state = new Map<string, unknown>();
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    companies: { get: async (id: string) => (PREFIXES[id] ? { id, issuePrefix: PREFIXES[id] } : null) },
    state: {
      get: async (k: { scopeId?: string; stateKey: string }) => state.get(`${k.scopeId}:${k.stateKey}`) ?? null,
      set: async (k: { scopeId?: string; stateKey: string }, v: unknown) => void state.set(`${k.scopeId}:${k.stateKey}`, v),
    },
    skills: { managed: { reconcile: async () => ({ defaultDrift: null }), reset: async (key: string, companyId: string) => void resets.push({ key, companyId }) } },
  } as unknown as PluginContext;
  return { ctx, resets };
}

describe("own-company SEO skill", () => {
  it("is declared in the manifest next to the shared skill", () => {
    const keys = (manifest.skills ?? []).map((s) => s.skillKey);
    expect(keys).toEqual([SKILL_KEY, OWN_SKILL_KEY]);
    expect(PIB_ONLY_SKILLS.map((s) => s.skillKey)).toEqual([OWN_SKILL_KEY]);
  });

  it("syncs for the PAR company, with the shared skill", async () => {
    const { ctx, resets } = stubCtx();
    await createSkillSyncers(ctx).ensure("par");
    expect(resets.map((r) => r.key).sort()).toEqual([OWN_SKILL_KEY, SKILL_KEY].sort());
  });

  it("does not sync for another company; the shared skill still does", async () => {
    const { ctx, resets } = stubCtx();
    const syncer = createSkillSyncers(ctx);
    await syncer.ensure("client");
    await syncer.force("client");
    await syncer.check("client");
    expect(resets.every((r) => r.key === SKILL_KEY)).toBe(true);
    expect(resets.length).toBeGreaterThan(0);
  });
});
