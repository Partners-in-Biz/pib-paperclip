/** Fails: the table still has rows for an action and a tool that are no longer registered. */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { fixtureManifest, guardWithBasics, VIEW, type Fixture } from "../../base.js";

const manifest = fixtureManifest("fixture.stale-row");
const table = { save: VIEW, "tool:look": VIEW, removed: VIEW, "tool:removed": VIEW };
export const fixture: Fixture = { manifest, table, setup: (ctx: PluginContext) => void guardWithBasics(ctx, manifest, table) };
