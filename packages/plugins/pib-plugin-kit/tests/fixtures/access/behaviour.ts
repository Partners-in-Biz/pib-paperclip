/**
 * Fixture plugins for the behaviour checks (plan 4.5 items 4 to 6): one correct,
 * and one per check with the plugin-side mistake that check exists to catch.
 */
import type { PluginApiRequestInput, PluginContext } from "@paperclipai/plugin-sdk";
import { ADMIN_ONLY, ANY_MEMBER, createAccessGuard, type AccessGuard, type AccessTable } from "../../../src/access/guard.js";
import { DECLARATION, FIXTURE_CAPABILITIES, fixtureManifest, handler, VIEW, type Fixture } from "./base.js";

interface Mistake {
  /** Capability the manifest lacks. */
  without?: string;
  /** The guard gets another plugin key than the manifest id. */
  guardKey?: string;
  /** Rows the guard gets that differ from the table the plugin exports. */
  guardRows?: AccessTable;
  /** `onApiRequest` answers its routes itself, not through the guard. */
  bypassRoutes?: true;
  /** The guard gets a ctx whose `events.on` subscribes nothing, so no receiver listens. */
  noSubscribe?: true;
}

/** A ctx like the plugin's, but `events.on` drops the subscription. */
const deafCtx = (ctx: PluginContext): PluginContext => {
  const events = { ...ctx.events, on: () => () => undefined } as PluginContext["events"];
  return new Proxy(ctx, { get: (target, prop) => (prop === "events" ? events : Reflect.get(target, prop)) });
};

function behaviourFixture(id: string, m: Mistake = {}): Fixture {
  const manifest = fixtureManifest(id, ["items"], FIXTURE_CAPABILITIES.filter((c) => c !== m.without));
  const table: AccessTable = { save: VIEW, open: ANY_MEMBER("every page reads it"), admin: ADMIN_ONLY, "tool:look": VIEW, "api:items": VIEW };
  const items = async () => ({ status: 200, body: [] });
  let guard: AccessGuard | null = null;
  return {
    manifest,
    table,
    setup(ctx) {
      guard = createAccessGuard(m.noSubscribe ? deafCtx(ctx) : ctx, { pluginKey: m.guardKey ?? id, table: { ...table, ...m.guardRows } });
      for (const key of ["save", "open", "admin"]) guard.action(key, handler);
      guard.tool("look", DECLARATION, async () => ({ content: "looked" }));
      guard.apiRoute("items", items);
    },
    onApiRequest: async (input: PluginApiRequestInput) => (m.bypassRoutes ? items() : guard!.handleApiRequest(input)),
  };
}

export const BEHAVIOUR_FIXTURES = {
  good: behaviourFixture("fixture.behaviour-good"),
  /** Item 4, switch absent and `off`: the switch cannot be read, so the guard enforces. */
  "no-state-read": behaviourFixture("fixture.no-state-read", { without: "plugin.state.read" }),
  /** Item 4, no grant: the guard was given a looser table than the one the plugin exports. */
  "table-mismatch": behaviourFixture("fixture.table-mismatch", { guardRows: { save: ANY_MEMBER("left open by mistake") } }),
  /** Item 4, owner: members cannot be read, so the owner is refused. */
  "no-members-read": behaviourFixture("fixture.no-members-read", { without: "access.members.read" }),
  /** Item 4, row missing: not this plugin's guard, so every call skips the checks. */
  "wrong-plugin-key": behaviourFixture("fixture.wrong-plugin-key", { guardKey: "fixture.other" }),
  /** Item 5: the run cannot be read, so a run working for the owner is refused. */
  "no-run-read": behaviourFixture("fixture.no-run-read", { without: "database.namespace.read" }),
  /** Item 6: routes answered outside the guard. */
  "route-bypass": behaviourFixture("fixture.route-bypass", { bypassRoutes: true }),
  /** Item 1.5: the guard's receiver never subscribes, so Setup's send is never received. */
  "no-receiver": behaviourFixture("fixture.no-receiver", { noSubscribe: true }),
  /** Item 1.5: the receiver cannot write its row, so it never confirms. */
  "no-state-write": behaviourFixture("fixture.no-state-write", { without: "plugin.state.write" }),
  /** Item 1.5: the receiver writes its row but cannot send the confirmation. */
  "no-emit": behaviourFixture("fixture.no-emit", { without: "events.emit" }),
} satisfies Record<string, Fixture>;
