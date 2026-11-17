/** Fails: Studio's form, `register.call` with a home-made check around the handler. */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { fixtureManifest, guardWithBasics, handler, VIEW, type Fixture } from "../../base.js";

const manifest = fixtureManifest("fixture.direct-call");
const table = { save: VIEW, "tool:look": VIEW, "set-limit": VIEW };
export const fixture: Fixture = {
  manifest,
  table,
  setup(ctx: PluginContext) {
    guardWithBasics(ctx, manifest, table);
    const action = (key: string, fn: typeof handler) => ctx.actions.register.call(ctx.actions, key, fn);
    action("set-limit", handler);
  },
};
