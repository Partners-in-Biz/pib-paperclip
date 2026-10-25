/**
 * Skills only the instance's own company (issue prefix PAR) receives.
 *
 * The host writes one manifest text to every company, so facts that belong to
 * the owner company (its people, its books, its client batches) cannot sit in a
 * shared skill. A plugin lists them apart (`PIB_ONLY_SKILLS`, exported from its
 * `manifest.ts`, also declared in the manifest `skills:` so the host knows the
 * key) and syncs them through `createPibOnlySkillSyncer`, which does nothing
 * for any other company.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { createSkillSyncer, type SkillDeclarationLike, type SkillSyncResult } from "./skills.js";

/** The issue prefix of the instance's own company. Campaigns and Mailbox keep their own copy of this rule for preferences. */
export const OWN_COMPANY_PREFIX = "PAR";

/** True when `companyId` is the instance's own company. A lookup that fails or finds no company is false (fail closed: nobody else gets the text). */
export async function isParCompany(ctx: PluginContext, companyId: string): Promise<boolean> {
  try {
    return (await ctx.companies.get(companyId))?.issuePrefix === OWN_COMPANY_PREFIX;
  } catch (error) {
    ctx.logger.warn("Own-company lookup failed; treated as another company", { companyId, error: error instanceof Error ? error.message : String(error) });
    return false;
  }
}

/**
 * `createSkillSyncer` for skills only PAR may read. `ensure`, `force` and `check`
 * (so also the sweep, `syncAllCompanies`) return [] and touch nothing for any
 * other company, and for a company whose lookup failed. Pass `isEnabled` to
 * `syncAllCompanies` so the sweep records those companies as skipped.
 */
export function createPibOnlySkillSyncer(ctx: PluginContext, skills: SkillDeclarationLike[]) {
  const inner = createSkillSyncer(ctx, skills);
  const none = async (): Promise<SkillSyncResult[]> => [];
  const gated =
    (run: (companyId: string) => Promise<SkillSyncResult[]>) =>
    async (companyId: string): Promise<SkillSyncResult[]> =>
      (await isParCompany(ctx, companyId)) ? run(companyId) : none();
  return {
    skills: inner.skills,
    isEnabled: (companyId: string) => isParCompany(ctx, companyId),
    ensure: gated((id) => inner.ensure(id)),
    force: gated((id) => inner.force(id)),
    check: gated((id) => inner.check(id)),
  };
}
