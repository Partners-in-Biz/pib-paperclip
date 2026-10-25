/**
 * GrowthStore on the plugin namespace. The generic tables (programs, versions,
 * experiments, items, changes) are the kit store (`createGrowthStore`); the
 * Social-only post features, scores and metrics are in features-sql.ts. Host
 * SQL guard rules apply (see db.ts).
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { createGrowthStore, isClientKind, AUTOPILOT_MODES, type Autopilot } from "@partnersinbiz/pib-plugin-kit";
import { table } from "../db.js";
import { sqlFeatures } from "./features-sql.js";
import type { CoreGrowthStore, CoreGrowthTypes, GrowthStore, Program } from "./store.js";

export function sqlCoreStore(ctx: PluginContext): CoreGrowthStore {
  return createGrowthStore<CoreGrowthTypes>({
    db: ctx.db,
    table: (name) => table(ctx, name),
    programApproval: true,
    // Social keeps its own autopilot fallback: an unknown value reads as "safe".
    mapProgram: (p) =>
      ({
        ...p,
        clientKind: p.clientRef ? (isClientKind(p.clientKind) ? p.clientKind : "company") : null,
        autopilot: AUTOPILOT_MODES.includes(p.autopilot as Autopilot) ? (p.autopilot as Autopilot) : "safe",
      }) as unknown as Program,
  });
}

/** Core store plus the Social-only features port, as the service sees it. */
export function sqlGrowthStore(ctx: PluginContext): GrowthStore {
  const core = sqlCoreStore(ctx);
  const features = sqlFeatures(ctx);
  return { ...core, ...features } as GrowthStore;
}
