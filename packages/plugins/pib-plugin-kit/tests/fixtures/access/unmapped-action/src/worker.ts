/** Fails: the action `export` goes through the guard but has no table row. */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { fixtureManifest, guardWithBasics, handler, VIEW, type Fixture } from "../../base.js";

const manifest = fixtureManifest("fixture.unmapped-action");
const table = { save: VIEW, "tool:look": VIEW };
export const fixture: Fixture = {
  manifest,
  table,
  setup(ctx: PluginContext) {
    guardWithBasics(ctx, manifest, table).action("export", handler);
  },
};
