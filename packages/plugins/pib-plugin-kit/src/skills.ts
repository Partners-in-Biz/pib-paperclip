/**
 * Versioned managed-skill sync.
 *
 * The host's `skills.managed.reconcile` never rewrites a skill that already
 * exists, so a plugin upgrade would leave agents on stale instructions. This
 * helper hashes each declared skill and calls `reset` (which replaces the
 * content in place, keeping the key and agent attachments) only when the hash
 * changed since the last sync for that company.
 */
import { createHash } from "node:crypto";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { withCompanyMemory } from "./memory.js";
import { withAskingSection } from "./asking.js";
import { rememberCompany } from "./known-companies.js";

export interface SkillDeclarationLike {
  skillKey: string;
  markdown?: string;
  files?: Array<{ path: string; content: string }>;
}

export interface SkillSyncResult {
  skillKey: string;
  action: "reset" | "reconcile" | "failed";
  error?: string;
}

export function skillVersion(skill: SkillDeclarationLike): string {
  const hash = createHash("sha256");
  hash.update(skill.skillKey);
  hash.update("\0");
  hash.update(skill.markdown ?? "");
  for (const file of [...(skill.files ?? [])].sort((a, b) => a.path.localeCompare(b.path))) {
    hash.update("\0");
    hash.update(file.path);
    hash.update("\0");
    hash.update(file.content);
  }
  return hash.digest("hex").slice(0, 16);
}

function stateKey(companyId: string, skillKey: string) {
  return { scopeKind: "company" as const, scopeId: companyId, namespace: "pib-kit", stateKey: `skill-ver:${skillKey}` };
}

export async function syncManagedSkills(
  ctx: PluginContext,
  companyId: string,
  skills: SkillDeclarationLike[],
  options: { force?: boolean } = {},
): Promise<SkillSyncResult[]> {
  const results: SkillSyncResult[] = [];
  for (const skill of skills) {
    const version = skillVersion(skill);
    try {
      const deployed = options.force ? null : await ctx.state.get(stateKey(companyId, skill.skillKey));
      if (deployed === version) {
        const resolution = (await ctx.skills.managed.reconcile(skill.skillKey, companyId)) as { defaultDrift?: { changedFiles?: string[] } | null } | null;
        // The marker says this version is deployed, but the company's copy can still differ (an upgrade
        // interrupted mid-copy, or an edit): only an unchanged copy counts as up to date.
        if (!resolution?.defaultDrift?.changedFiles?.length) {
          results.push({ skillKey: skill.skillKey, action: "reconcile" });
          continue;
        }
      }
      await ctx.skills.managed.reset(skill.skillKey, companyId);
      await ctx.state.set(stateKey(companyId, skill.skillKey), version);
      results.push({ skillKey: skill.skillKey, action: "reset" });
    } catch (error) {
      results.push({ skillKey: skill.skillKey, action: "failed", error: error instanceof Error ? error.message : String(error) });
    }
  }
  return results;
}

/**
 * Sync once per company per worker process. Call it from any company-scoped
 * entry point (actions, tools, events, jobs with an explicit company).
 *
 * - `ensure`: once per company per process (memoised).
 * - `force`: always resets every skill.
 * - `check`: syncs only what changed, every time it is called (not memoised);
 *   what `syncAllCompanies` and the periodic sweep use, so a copy that was
 *   edited or left behind is found without a restart.
 *
 * Every call remembers the company (kit `rememberCompany`), so a job can later
 * find the companies this plugin has served without `ctx.companies.list`,
 * which the host refuses while another call is in flight.
 */
export function createSkillSyncer(ctx: PluginContext, skills: SkillDeclarationLike[]) {
  const done = new Map<string, Promise<SkillSyncResult[]>>();
  return {
    /** The declarations this syncer keeps in step (for drift checks). */
    skills,
    ensure(companyId: string): Promise<SkillSyncResult[]> {
      void rememberCompany(ctx, companyId);
      const existing = done.get(companyId);
      if (existing) return existing;
      const run = syncManagedSkills(ctx, companyId, skills).then((results) => {
        const failed = results.filter((r) => r.action === "failed");
        if (failed.length > 0) {
          done.delete(companyId);
          ctx.logger.info("Managed skill sync incomplete", { companyId, failed });
        }
        return results;
      });
      done.set(companyId, run);
      return run;
    },
    force(companyId: string): Promise<SkillSyncResult[]> {
      void rememberCompany(ctx, companyId);
      done.delete(companyId);
      const run = syncManagedSkills(ctx, companyId, skills, { force: true });
      done.set(companyId, run);
      return run;
    },
    async check(companyId: string): Promise<SkillSyncResult[]> {
      void rememberCompany(ctx, companyId);
      const results = await syncManagedSkills(ctx, companyId, skills);
      if (results.every((r) => r.action !== "failed")) done.set(companyId, Promise.resolve(results));
      return results;
    },
  };
}

/** What `createSkillSyncer` returns. */
export type SkillSyncer = ReturnType<typeof createSkillSyncer>;

/**
 * Prepend frontmatter with a unique pib- slug so reset never clobbers other
 * company skills, and append the company memory section (read before, write
 * after) and the "Asking a person" section unless `memory: false` (or
 * `asking: false` for the asking section alone).
 */
export function withFrontmatter(input: { name: string; description: string; memory?: boolean; asking?: boolean }, body: string): string {
  const description = input.description.replace(/\s+/g, " ").trim().replace(/"/g, "'");
  let content = input.memory === false ? body.trimStart() : withCompanyMemory(body.trimStart());
  if (input.asking !== false && input.memory !== false) content = withAskingSection(content);
  return `---\nname: ${input.name}\nslug: ${input.name}\ndescription: "${description}"\n---\n\n${content}`;
}
