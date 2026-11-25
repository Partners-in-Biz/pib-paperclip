/** Correct: every action, tool and route through the guard and in the table; Voice's two named data handlers. */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { fixtureManifest, guardWithBasics, handler, VIEW, type Fixture } from "../../base.js";

const manifest = fixtureManifest("partnersinbiz.voice", ["items"]);
const table = { save: VIEW, "tool:look": VIEW, "api:items": VIEW };
export const fixture: Fixture = {
  manifest,
  table,
  setup(ctx: PluginContext) {
    const guard = guardWithBasics(ctx, manifest, table);
    guard.apiRoute("items", async () => ({ status: 200, body: [] }));
    ctx.data.register("status", handler);
    ctx.data.register("agent-voice", handler);
  },
};
