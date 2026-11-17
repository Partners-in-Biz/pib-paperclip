/** Fails: a data handler in a plugin that has no named data handlers (it carries no caller). */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { fixtureManifest, guardWithBasics, handler, VIEW, type Fixture } from "../../base.js";

const manifest = fixtureManifest("fixture.extra-data-handler");
const table = { save: VIEW, "tool:look": VIEW };
export const fixture: Fixture = {
  manifest,
  table,
  setup(ctx: PluginContext) {
    guardWithBasics(ctx, manifest, table);
    ctx.data.register("rows", handler);
  },
};
