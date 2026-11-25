/** Fails: an action registered straight on the context, past the guard (its row exists). */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { fixtureManifest, guardWithBasics, handler, VIEW, type Fixture } from "../../base.js";

const manifest = fixtureManifest("fixture.direct-register");
const table = { save: VIEW, "tool:look": VIEW, raw: VIEW };
export const fixture: Fixture = {
  manifest,
  table,
  setup(ctx: PluginContext) {
    guardWithBasics(ctx, manifest, table);
    ctx.actions.register("raw", handler);
  },
};
