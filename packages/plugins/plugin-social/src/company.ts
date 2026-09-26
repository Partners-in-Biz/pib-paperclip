/**
 * Per-company bootstrap, run from company-scoped entry points (actions,
 * tools, routes, company.created) and at the start of per-company job work.
 * Never iterates companies itself: jobs take company ids from our own rows.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { createSkillSyncer } from "@partnersinbiz/pib-plugin-kit";
import { deleteJunkAccounts, flagLegacyTokens } from "./db.js";
import { SKILLS } from "./skills.js";

export function createCompanyBootstrap(ctx: PluginContext) {
  const skills = createSkillSyncer(ctx, SKILLS);
  const cleaned = new Set<string>();
  return {
    skills,
    async ensure(companyId: string): Promise<void> {
      if (!companyId) return;
      try {
        await skills.ensure(companyId);
      } catch (error) {
        ctx.logger.info("Social skill sync skipped", { companyId, error: error instanceof Error ? error.message : String(error) });
      }
      if (!cleaned.has(companyId)) {
        cleaned.add(companyId);
        try {
          const removed = await deleteJunkAccounts(ctx, companyId);
          if (removed) ctx.logger.info("Removed social accounts without credentials", { companyId, removed });
          const legacy = await flagLegacyTokens(ctx, companyId);
          if (legacy) ctx.logger.info("Social accounts with old-format tokens need reconnecting", { companyId, legacy });
        } catch (error) {
          cleaned.delete(companyId);
          ctx.logger.info("Social account cleanup skipped", { companyId, error: error instanceof Error ? error.message : String(error) });
        }
      }
    },
  };
}

export type CompanyBootstrap = ReturnType<typeof createCompanyBootstrap>;
