import { describe, expect, it } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import manifest, { PIB_ONLY_SKILLS as MANIFEST_PIB_ONLY } from "../src/manifest.js";
import { createCompanyBootstrap } from "../src/company.js";
import { DESIRED_SKILLS, PIB_ONLY_SKILLS, SKILLS } from "../src/skills.js";

const PIB_WORDING = /Peet|Partners in Biz|\bPiB\b/;

/** Just enough host for the skill sync: company lookup, state, and the managed-skill reset/reconcile calls. */
function skillCtx(prefixes: Record<string, string>) {
  const resets: Array<{ key: string; companyId: string }> = [];
  const state = new Map<string, unknown>();
  const ctx = {
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    companies: { get: async (id: string) => (prefixes[id] ? { id, issuePrefix: prefixes[id] } : null) },
    state: {
      get: async (k: { scopeId?: string; stateKey: string }) => state.get(`${k.scopeId}|${k.stateKey}`) ?? null,
      set: async (k: { scopeId?: string; stateKey: string }, v: unknown) => void state.set(`${k.scopeId}|${k.stateKey}`, v),
    },
    skills: {
      managed: {
        reset: async (key: string, companyId: string) => void resets.push({ key, companyId }),
        reconcile: async () => null,
      },
    },
  } as unknown as PluginContext;
  return { ctx, resets };
}

describe("own-company notes skill", () => {
  it("is declared in the manifest but not given to the managed agent", () => {
    expect(PIB_ONLY_SKILLS.map((s) => s.skillKey)).toEqual(["social-own-notes"]);
    expect(MANIFEST_PIB_ONLY).toBe(PIB_ONLY_SKILLS);
    expect(manifest.skills!.map((s) => s.skillKey)).toContain("social-own-notes");
    expect(DESIRED_SKILLS.join()).not.toContain("social-own-notes");
  });

  it("the shared skill text names no owner company", () => {
    const docs = SKILLS.flatMap((s) => [s.markdown, ...(s.files ?? []).map((f) => f.content)]);
    for (const doc of docs) expect(doc).not.toMatch(PIB_WORDING);
    expect(PIB_ONLY_SKILLS[0]!.markdown).toContain("PARA-4");
  });

  it("syncs for the PAR company and not for another", async () => {
    const { ctx, resets } = skillCtx({ par: "PAR", client: "ACM" });
    const bootstrap = createCompanyBootstrap(ctx);
    await bootstrap.ownSkills.ensure("client");
    expect(resets).toEqual([]);
    await bootstrap.ownSkills.ensure("par");
    expect(resets).toEqual([{ key: "social-own-notes", companyId: "par" }]);
  });
});
