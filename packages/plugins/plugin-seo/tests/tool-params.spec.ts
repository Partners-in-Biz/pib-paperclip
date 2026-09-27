import { describe, expect, it } from "vitest";
import { dispatch, HANDLERS } from "../src/dispatch.js";
import type { NeedsYouKind } from "../src/engine/needs-you.js";
import { PLAYBOOK_SECTIONS, type ChangeOp } from "../src/engine/playbook.js";
import { CHANGE_POLICIES, HOSTINGS, SEO_SCOPE_CATEGORIES, type ChecksState } from "../src/engine/site-change.js";
import { AUTOPILOT_MODES, SPRINT_STATUSES, TASK_STATUSES, type TaskSource } from "../src/engine/sprint.js";
import type { VerificationMethod } from "../src/integrations/google-sa.js";
import type { Strategy } from "../src/integrations/pagespeed.js";
import type { Env } from "../src/service/common.js";
import { BACKLINK_STATUSES, BACKLINK_TYPES, CONTENT_STATUSES, CONTENT_TYPES, FINDING_SEVERITIES, INTENTS } from "../src/service/data.js";
import type { TaskOwner } from "../src/templates/outrank-90.js";
import { SEO_TOOL_DECLARATIONS, SEO_TOOLS } from "../src/tools.js";

type Schema = { type?: string; description?: unknown; enum?: unknown[]; properties?: Record<string, Schema>; items?: Schema; required?: string[]; additionalProperties?: unknown };

/** Every schema node under a tool's parameters (object properties, array items, nested objects), with its path. */
function nodes(schema: Schema, path: string): Array<{ path: string; node: Schema; property: boolean }> {
  const out: Array<{ path: string; node: Schema; property: boolean }> = [];
  for (const [key, prop] of Object.entries(schema.properties ?? {})) {
    out.push({ path: `${path}.${key}`, node: prop, property: true }, ...nodes(prop, `${path}.${key}`));
  }
  if (schema.items) out.push({ path: `${path}[]`, node: schema.items, property: false }, ...nodes(schema.items, `${path}[]`));
  return out;
}

const ALL = SEO_TOOLS.flatMap((tool) => nodes(tool.parametersSchema as Schema, tool.name));
const PARAMS = ALL.filter((n) => n.property);

/** The schema at a path like `keywords[].intent` or `status[]` in a tool's parameters. */
function at(tool: string, path: string): Schema {
  let node = SEO_TOOLS.find((t) => t.name === tool)?.parametersSchema as Schema | undefined;
  for (const token of path.match(/\[\]|[^.[\]]+/g) ?? []) node = token === "[]" ? node?.items : node?.properties?.[token];
  if (!node) throw new Error(`${tool} has no parameter ${path}`);
  return node;
}

const REMOVED = ["open-task", "add-keyword", "record-rank", "rank-history", "add-page", "record-audit"];

describe("tool parameters", () => {
  it("gives every parameter, nested ones included, a one-line description", () => {
    expect(PARAMS.map((n) => n.path)).toEqual(expect.arrayContaining(["add-keywords.keywords[].phrase", "complete-task.artifacts[].label", "check-change-scope.changes[].category"]));
    const missing = PARAMS.filter(({ node }) => typeof node.description !== "string" || !node.description.trim()).map((n) => n.path);
    expect(missing).toEqual([]);
    const tooLong = PARAMS.filter(({ node }) => /\n/.test(String(node.description)) || String(node.description).length > 200).map((n) => n.path);
    expect(tooLong).toEqual([]);
  });

  it("keeps closed object schemas whose required params are declared", () => {
    for (const tool of SEO_TOOLS) {
      const root = tool.parametersSchema as Schema;
      expect(root, tool.name).toMatchObject({ type: "object", additionalProperties: false });
      for (const { path, node } of [{ path: tool.name, node: root }, ...nodes(root, tool.name)]) {
        for (const key of node.required ?? []) expect(node.properties?.[key], `${path}.${key}`).toBeDefined();
      }
    }
  });

  it("lists fixed values as non-empty enums without duplicates", () => {
    const enums = ALL.filter(({ node }) => node.enum);
    expect(enums.length).toBeGreaterThan(30);
    for (const { path, node } of enums) {
      expect(node.enum!.length, path).toBeGreaterThan(0);
      expect(new Set(node.enum).size, path).toBe(node.enum!.length);
      expect(node.enum!.every((v) => typeof v === "string"), path).toBe(true);
    }
  });

  // tools.ts copies the service/data.ts values (node-only, so the manifest does not import it) and imports the engine ones.
  it.each([
    ["list-sprints", "status", SPRINT_STATUSES],
    ["set-autopilot", "mode", AUTOPILOT_MODES],
    ["list-tasks", "status[]", TASK_STATUSES],
    ["add-keywords", "keywords[].intent", INTENTS],
    ["update-keyword", "intent", INTENTS],
    ["list-backlinks", "status", BACKLINK_STATUSES],
    ["list-backlinks", "type", BACKLINK_TYPES],
    ["add-backlink", "status", BACKLINK_STATUSES],
    ["add-backlink", "type", BACKLINK_TYPES],
    ["update-backlink", "status", BACKLINK_STATUSES],
    ["update-backlink", "type", BACKLINK_TYPES],
    ["list-content", "status", CONTENT_STATUSES],
    ["list-content", "type", CONTENT_TYPES],
    ["add-content", "status", CONTENT_STATUSES],
    ["add-content", "type", CONTENT_TYPES],
    ["update-content", "status", CONTENT_STATUSES],
    ["update-content", "type", CONTENT_TYPES],
    ["record-finding", "severity", FINDING_SEVERITIES],
    ["link-site", "hosting", HOSTINGS],
    ["link-site", "changePolicy", CHANGE_POLICIES],
    ["check-change-scope", "changes[].category", [...SEO_SCOPE_CATEGORIES, "other"]],
    ["propose-playbook-change", "section", PLAYBOOK_SECTIONS],
    ["create-sprint", "autopilotMode", AUTOPILOT_MODES.filter((mode) => mode !== "full")],
    // The Social plugin's ALL_PLATFORMS (plugin-social/src/platforms.ts).
    ["link-social-post", "platform", ["facebook", "instagram", "threads", "linkedin", "x", "tiktok", "youtube", "pinterest", "reddit", "bluesky", "mastodon", "dribbble"]],
  ] as Array<[string, string, readonly string[]]>)("%s %s takes exactly the values the service accepts", (tool, path, values) => {
    expect(at(tool, path).enum).toEqual([...values]);
  });

  it("matches the service's union types where no constant exists", () => {
    // Record<Union, true> fails to compile when the union gains or loses a value.
    const owners: Record<TaskOwner, true> = { agent: true, human: true };
    const sources: Record<TaskSource, true> = { template: true, manual: true, optimization: true };
    const kinds: Record<NeedsYouKind, true> = { grant: true, review: true, pr: true, message: true, task: true, indexing: true };
    const checks: Record<ChecksState, true> = { passed: true, failed: true, pending: true };
    const strategies: Record<Strategy, true> = { mobile: true, desktop: true };
    const methods: Record<VerificationMethod, true> = { META: true, FILE: true, DNS_TXT: true };
    const ops: Record<ChangeOp, true> = { add: true, remove: true, replace: true };
    const cases: Array<[string, string, Record<string, true>]> = [
      ["list-tasks", "owner", owners],
      ["add-task", "owner", owners],
      ["list-tasks", "source", sources],
      ["needs-you-add", "kind", kinds],
      ["check-change-scope", "checks", checks],
      ["run-pagespeed", "strategy", strategies],
      ["gsc-verification-token", "method", methods],
      ["gsc-verify-site", "method", methods],
      ["propose-playbook-change", "op", ops],
    ];
    for (const [tool, path, union] of cases) expect([...(at(tool, path).enum ?? [])].sort(), `${tool} ${path}`).toEqual(Object.keys(union).sort());
  });
});

describe("tool set", () => {
  it("has a handler for every declared tool and nothing undeclared", () => {
    expect(SEO_TOOLS.map((t) => t.name).sort()).toEqual(Object.keys(HANDLERS).sort());
    expect(new Set(SEO_TOOLS.map((t) => t.name)).size).toBe(SEO_TOOLS.length);
    expect(SEO_TOOLS.map((t) => t.name)).toEqual(SEO_TOOL_DECLARATIONS.map((t) => t.name));
  });

  it("no longer declares or dispatches the legacy aliases", async () => {
    for (const name of REMOVED) {
      expect(SEO_TOOLS.map((t) => t.name), name).not.toContain(name);
      expect(HANDLERS[name], name).toBeUndefined();
      await expect(dispatch({} as Env, "c", { kind: "system" }, name, {}), name).rejects.toThrow(`Unknown SEO tool ${name}`);
    }
  });
});
