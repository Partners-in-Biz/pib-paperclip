/** Fails: CRM telephony's form, a context under another name. */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { fixtureManifest, guardWithBasics, handler, VIEW, type Fixture } from "../../base.js";

const manifest = fixtureManifest("fixture.direct-plugin-ctx");
const table = { save: VIEW, "tool:look": VIEW, "voice-token": VIEW };
export const fixture: Fixture = {
  manifest,
  table,
  setup(pluginCtx: PluginContext) {
    guardWithBasics(pluginCtx, manifest, table);
    pluginCtx.actions.register("voice-token", handler);
  },
};
