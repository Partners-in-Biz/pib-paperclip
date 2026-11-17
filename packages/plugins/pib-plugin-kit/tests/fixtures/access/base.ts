/** Shared parts of the access fixture plugins (tests/access-testing.spec.ts). Outside every fixture's `src/`. */
import type { PaperclipPluginManifestV1, PluginContext } from "@paperclipai/plugin-sdk";
import { createAccessGuard, type AccessGuard, type AccessTable } from "../../../src/access/guard.js";

export interface Fixture {
  manifest: PaperclipPluginManifestV1;
  table: AccessTable;
  setup(ctx: PluginContext): void;
}

export const fixtureManifest = (id: string, routeKeys: string[] = []) =>
  ({
    id,
    apiVersion: 1,
    version: "0.0.0",
    displayName: "Access fixture",
    description: "test",
    author: "test",
    categories: ["automation"],
    capabilities: ["agent.tools.register", "api.routes.register", "plugin.state.read"],
    entrypoints: { worker: "worker.js" },
    apiRoutes: routeKeys.map((routeKey) => ({ routeKey, method: "GET", path: `/${routeKey}`, auth: "board", capability: "api.routes.register", companyResolution: { from: "query", key: "companyId" } })),
  }) as unknown as PaperclipPluginManifestV1;

export const VIEW = { resource: "crm.contacts", action: "view" } as const;
export const handler = async () => ({ ok: true });
const DECLARATION = { displayName: "Look", description: "Look", parametersSchema: { type: "object" } };

/** A guard with the action `save` and the tool `look`, the common part of every fixture. */
export function guardWithBasics(ctx: PluginContext, manifest: PaperclipPluginManifestV1, table: AccessTable): AccessGuard {
  const guard = createAccessGuard(ctx, { pluginKey: manifest.id, table });
  guard.action("save", handler);
  guard.tool("look", DECLARATION, async () => ({ content: "looked" }));
  return guard;
}
