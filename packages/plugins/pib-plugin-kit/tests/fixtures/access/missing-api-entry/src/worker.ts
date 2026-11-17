/** Fails: the manifest declares the route `export` with no `api:export` row. */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { fixtureManifest, guardWithBasics, VIEW, type Fixture } from "../../base.js";

const manifest = fixtureManifest("fixture.missing-api-entry", ["items", "export"]);
const table = { save: VIEW, "tool:look": VIEW, "api:items": VIEW };
export const fixture: Fixture = {
  manifest,
  table,
  setup(ctx: PluginContext) {
    const guard = guardWithBasics(ctx, manifest, table);
    guard.apiRoute("items", async () => ({ status: 200, body: [] }));
    guard.apiRoute("export", async () => ({ status: 200, body: [] }));
  },
};
