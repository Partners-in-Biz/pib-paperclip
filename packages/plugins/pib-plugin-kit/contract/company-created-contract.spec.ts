/**
 * Cross-plugin contract: a new company is set up the same way by every plugin,
 * and a plugin that reads the team roles keeps its copy fresh (Q7-12, Q5-6).
 *
 * 1. Every plugin manifest that declares skills handles `company.created`
 *    (directly, or through the kit's `registerCompanyBootstrap`), or is listed
 *    in `EXEMPT` with a reason. Nothing tested this path before, and the Cockpit
 *    had no handler at all: a new company got the Cockpit's skills only when
 *    someone happened to touch it.
 * 2. At most one `company.created` subscription per plugin: every
 *    `ctx.events.on` is its own host subscription and the worker would run both
 *    handlers on each delivery (a doubled "Set up <company>" issue).
 * 3. A plugin whose code reads the roles copy (`companyRoles`, `routeWork`,
 *    `reviewerAgentId`...) registers the watch that fills it, or is the Cockpit,
 *    which writes its own copy. A plugin that reads a copy nobody fills routes
 *    every approval to nobody.
 *
 * 4. No plugin subscribes to the same core event twice, counting the kit
 *    helpers that subscribe for it (`registerHireWatch` -> the agent events,
 *    `registerCompanyBootstrap` -> `company.created` and its lazy events,
 *    `registerDoneChecks` -> `issue.updated`). The host pushes one entry per
 *    `ctx.events.on` and the worker runs every handler on each delivery, so a
 *    second handler for a name runs twice on every event.
 *
 * It reads plugin sources, so run it after changing any plugin's worker.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { HIRE_WATCH_EVENTS } from "../src/agent-hire.js";
import { LAZY_BOOTSTRAP_EVENTS } from "../src/company.js";

const PLUGINS = ["cockpit", "crm", "mailbox", "social", "seo", "campaigns", "billing", "accounting", "payroll", "partners", "setup"] as const;

/**
 * Plugins allowed to have no `company.created` handler, with why. An entry that
 * is no longer needed is harmless (the test only warns); remove it.
 */
const EXEMPT: Record<string, string> = {
  cockpit: "The Cockpit syncs its skills lazily (register.ts) and has no company.created handler yet; the Wave 3 Cockpit builder adds registerCompanyBootstrap, which makes this entry stale. Remove it then.",
};

/** Plugins that read the roles copy without `registerRoleWatch`, because they write the copy themselves. */
const WRITES_OWN_ROLES = new Set(["cockpit"]);

type Manifest = { id: string; skills?: Array<{ skillKey: string }> };

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name === "ui") continue;
      out.push(...sources(path));
    } else if (/\.tsx?$/.test(name)) out.push(path);
  }
  return out;
}

const pluginSource = (plugin: string) => sources(fileURLToPath(new URL(`../../plugin-${plugin}/src`, import.meta.url))).map((file) => readFileSync(file, "utf8")).join("\n");

const COMPANY_CREATED = /events\.on\(\s*["'`]company\.created["'`]/g;
const BOOTSTRAP = /\bregisterCompanyBootstrap\(\s*ctx/g;
const READS_ROLES = /\b(companyRoles|routeWork|routeRole|reviewerAgentId|operatorAgentId|teamAgentId|reopenApprovalForPerson|resolveApprover|openApprovalIssue)\(/;

describe("company.created", async () => {
  const manifests = new Map<string, Manifest>();
  for (const plugin of PLUGINS) manifests.set(plugin, (await import(`../../plugin-${plugin}/src/manifest.ts`)).default as Manifest);
  const withSkills = PLUGINS.filter((plugin) => (manifests.get(plugin)!.skills ?? []).length > 0);

  it("covers every plugin that has skills", () => {
    expect(withSkills.length).toBeGreaterThanOrEqual(10);
  });

  it.each(withSkills)("%s handles company.created, or is exempt with a reason", (plugin) => {
    const text = pluginSource(plugin);
    const handled = (text.match(COMPANY_CREATED)?.length ?? 0) + (text.match(BOOTSTRAP)?.length ?? 0) > 0;
    if (!handled) {
      expect(EXEMPT[plugin], `${plugin} declares skills but never handles company.created: call registerCompanyBootstrap(ctx, { syncer }) in setup`).toBeTruthy();
    } else if (EXEMPT[plugin]) {
      // eslint-disable-next-line no-console
      console.warn(`[contract] ${plugin} handles company.created now: remove it from EXEMPT in company-created-contract.spec.ts`);
    }
  });

  it.each(PLUGINS)("%s subscribes to company.created at most once", (plugin) => {
    const text = pluginSource(plugin);
    const count = (text.match(COMPANY_CREATED)?.length ?? 0) + (text.match(BOOTSTRAP)?.length ?? 0);
    expect(count, "registerCompanyBootstrap already subscribes: do not also call ctx.events.on(\"company.created\")").toBeLessThanOrEqual(1);
  });

  it("exempts only plugins that really lack a handler or are named plugins", () => {
    for (const plugin of Object.keys(EXEMPT)) expect(PLUGINS as readonly string[]).toContain(plugin);
  });
});

describe("the roles copy", () => {
  it.each(PLUGINS)("%s fills the roles copy it reads", (plugin) => {
    const text = pluginSource(plugin);
    if (!READS_ROLES.test(text) || WRITES_OWN_ROLES.has(plugin)) return;
    expect(text, `${plugin} reads the team roles but never calls registerRoleWatch(ctx) in setup, so its copy stays empty`).toMatch(/\bregisterRoleWatch\(\s*ctx\s*\)/);
  });
});

/** Source without comments, so a doc that mentions `registerHireWatch(` is not counted as a call. */
const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

/** How many handlers a plugin registers per core event name (literal `ctx.events.on` plus the kit helpers that subscribe). */
export function coreSubscriptions(source: string): Map<string, number> {
  const text = code(source);
  const counts = new Map<string, number>();
  const add = (name: string) => counts.set(name, (counts.get(name) ?? 0) + 1);
  for (const match of text.matchAll(/events\.on\(\s*["'`]([a-z_]+(?:\.[a-z_]+)+)["'`]/g)) {
    if (!match[1]!.startsWith("plugin.")) add(match[1]!);
  }
  if (/\bregisterHireWatch\(/.test(text)) for (const name of HIRE_WATCH_EVENTS) add(name);
  if (/\bregisterDoneChecks\(/.test(text)) add("issue.updated");
  if (/\bregisterCompanyBootstrap\(\s*ctx/.test(text)) {
    add("company.created");
    if (!/lazyOn:\s*false/.test(text)) for (const name of LAZY_BOOTSTRAP_EVENTS) add(name);
  }
  return counts;
}

describe("core event subscriptions", () => {
  it.each(PLUGINS)("%s has one handler per core event name", (plugin) => {
    const dupes = [...coreSubscriptions(pluginSource(plugin))].filter(([, count]) => count > 1).map(([name, count]) => `${name} x${count}`);
    expect(dupes, `${plugin} subscribes twice to a core event; the worker runs both handlers on every delivery. Merge them (registerHireWatch owns the agent events, registerCompanyBootstrap owns company.created)`).toEqual([]);
  });

  it("the counter itself sees a kit helper and a hand-written handler for the same event as two", () => {
    const both = coreSubscriptions(`registerHireWatch(ctx, []);\nctx.events.on("agent.created", async () => {});\n// registerHireWatch(ctx) in a comment\nctx.events.on("plugin.partnersinbiz.crm.x", f); ctx.events.on("issue.updated", f);`);
    expect(both.get("agent.created")).toBe(2);
    expect(both.get("agent.updated")).toBe(1);
    expect(both.get("issue.updated")).toBe(1);
    expect([...both.keys()].some((name) => name.startsWith("plugin."))).toBe(false);
    expect(coreSubscriptions(`registerCompanyBootstrap(ctx, {});\nctx.events.on("company.created", f);`).get("company.created")).toBe(2);
    expect(coreSubscriptions(`registerCompanyBootstrap(ctx, { lazyOn: false });`).has("company.updated")).toBe(false);
    // the combination every plugin that links hires will have: the kit's own defaults must not collide
    const together = coreSubscriptions(`registerHireWatch(ctx, []);\nregisterCompanyBootstrap(ctx, { syncer });\nregisterDoneChecks(ctx, rules);`);
    expect([...together].filter(([, count]) => count > 1)).toEqual([]);
    expect(coreSubscriptions(`registerDoneChecks(ctx, r);\nctx.events.on("issue.updated", f);`).get("issue.updated")).toBe(2);
  });
});
