/**
 * The access guard of SEO (access stage A, spec PAR-12578 sections 4.4 to 4.6; PAR-12676): the kit's test helper on the
 * real plugin (registration, table, source, behaviour, agent and API route checks), the one-file rule for
 * `usePluginAction`, the page's call actions, today's answers with the switch off, and the CRM's refusal on the page.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { ADMIN_ONLY } from "@partnersinbiz/pib-plugin-kit";
import { assertPluginAccess, ACCESS_TEST_IDS } from "@partnersinbiz/pib-plugin-kit/access-testing";
import { permissionRefusal } from "@partnersinbiz/pib-plugin-kit/refusal";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";
import { ACCESS_TABLE, PAGE_ONLY_HANDLERS, SEO_CALL_ACTIONS, seoCallAction } from "../src/access-table.js";
import { HANDLERS, UI_ONLY_HANDLERS } from "../src/dispatch.js";
import { parseCrmWorkspace, readCrmProfile } from "../src/ui/crm-profile.js";

const SRC = fileURLToPath(new URL("../src", import.meta.url));
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : /\.tsx?$/.test(name) ? [path] : [];
  });
const harnessOf = () => createTestHarness({ manifest, config: { timezone: "Africa/Johannesburg", publicBaseUrl: "https://paperclip.partnersinbiz.online" } });

describe("SEO access guard", () => {
  it("every action, tool and API route goes through the guard and the table; switch off passes, enforce refuses (4.5 items 1 to 6)", async () => {
    const harness = harnessOf();
    await assertPluginAccess({
      harness,
      setup: plugin.definition.setup,
      onApiRequest: plugin.definition.onApiRequest!,
      manifest,
      table: ACCESS_TABLE,
      srcDir: SRC,
    });
  });

  it("only src/ui/actions.ts imports usePluginAction; every other page file uses the wrapped hooks", () => {
    const direct = files(join(SRC, "ui"))
      .filter((f) => relative(SRC, f) !== join("ui", "actions.ts"))
      .filter((f) => /\busePluginAction\b/.test(readFileSync(f, "utf8")))
      .map((f) => relative(SRC, f));
    expect(direct).toEqual([]);
  });

  it("only seo.work rows are scoped (stage B2-4), no row names another plugin's resource, and the table's ADMIN_ONLY is the kit's", () => {
    for (const [key, entry] of Object.entries(ACCESS_TABLE)) {
      if (typeof entry !== "object" || !("resource" in entry)) continue;
      expect(entry.resource, key).toMatch(/^seo\.(work|settings)$/);
      if (entry.scoped) expect(entry.resource, key).toBe("seo.work");
    }
    expect(ACCESS_TABLE["seo.start-hire"]).toBe(ADMIN_ONLY);
  });

  it("each page handler has one call action of its own permission, and each call action carries at least one", () => {
    const handlers = [...Object.keys(HANDLERS), ...Object.keys(UI_ONLY_HANDLERS)];
    expect([...PAGE_ONLY_HANDLERS].sort()).toEqual(Object.keys(UI_ONLY_HANDLERS).sort());
    const used = new Set<string>();
    for (const name of handlers) {
      const key = seoCallAction(name);
      expect(key, name).not.toBeNull();
      used.add(key!);
      // An agent tool and its page handler need the same permission.
      const tool = ACCESS_TABLE[`tool:${name}`];
      if (tool && typeof tool === "object" && "resource" in tool) expect({ resource: tool.resource, action: tool.action }, name).toEqual(SEO_CALL_ACTIONS[key!]);
    }
    expect([...used].sort()).toEqual(Object.keys(SEO_CALL_ACTIONS).sort());
  });

  it("a handler sent through another permission's call action is refused, with the switch off too", async () => {
    const harness = harnessOf();
    await plugin.definition.setup(harness.ctx);
    const person = { companyId: ACCESS_TEST_IDS.off, actor: { type: "user" as const, userId: ACCESS_TEST_IDS.owner } };
    await expect(harness.performAction("seo.call", { tool: "archive-sprint", params: { sprintId: "sp" } }, person)).rejects.toThrow(/called through seo\.call-delete, not seo\.call/);
    await expect(harness.performAction("seo.call-edit", { tool: "decide-preview", params: {} }, person)).rejects.toThrow(/called through seo\.call-approve/);
  });

  it("the README's compact-task-thread call (an edit handler through seo.call-edit) answers as today with the switch off", async () => {
    const harness = harnessOf();
    await plugin.definition.setup(harness.ctx);
    const person = { companyId: ACCESS_TEST_IDS.off, actor: { type: "user" as const, userId: ACCESS_TEST_IDS.owner } };
    const call = { tool: "compact-task-thread", params: { issueId: "PAR-528", dryRun: true } };
    expect(seoCallAction("compact-task-thread")).toBe("seo.call-edit");
    await expect(harness.performAction("seo.call-edit", call, person)).resolves.toMatchObject({ dryRun: true, rolled: 0 });
    const readme = readFileSync(fileURLToPath(new URL("../README.md", import.meta.url)), "utf8");
    expect(readme).toContain("/actions/seo.call-edit` with `{\"companyId\": \"<company id>\", \"params\": {\"tool\": \"compact-task-thread\"");
    expect(readme).not.toMatch(/\/actions\/seo\.call` with `\{[^`]*"tool": "compact-task-thread"/);
  });

  it("with the switch off an unknown route answers as before (404), not a refusal", async () => {
    const harness = harnessOf();
    await plugin.definition.setup(harness.ctx);
    const answer = await plugin.definition.onApiRequest!({
      routeKey: "no-such-route",
      method: "GET",
      path: "/no-such-route",
      params: {},
      query: {},
      body: null,
      actor: { actorType: "user", actorId: ACCESS_TEST_IDS.operator, userId: ACCESS_TEST_IDS.operator },
      companyId: ACCESS_TEST_IDS.off,
      headers: {},
    });
    expect(answer).toEqual({ status: 404, body: { error: "Unknown route" } });
  });
});

describe("the CRM's client panel when the CRM refuses (4.4, calls from another plugin's page)", () => {
  afterEach(() => vi.unstubAllGlobals());
  const client = { kind: "company" as const, id: "crm-1" };

  it("a refusal answer gives no profile, so the page goes on without the CRM's hint", async () => {
    const refusal = permissionRefusal("You do not have permission to view companies");
    expect(parseCrmWorkspace(refusal)).toBeNull();
    expect(parseCrmWorkspace({ data: refusal })).toBeNull();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ data: refusal }), { status: 200 })));
    await expect(readCrmProfile("co-1", client)).resolves.toBeNull();
  });

  it("a 403 from the host (a viewer, or the CRM's own route refusal) gives no profile", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(permissionRefusal("No")), { status: 403 })));
    await expect(readCrmProfile("co-1", client)).resolves.toBeNull();
  });

  it("an open CRM still gives the profile (today's result)", async () => {
    const body = { data: { found: true, company: { name: "Acme", domain: "acme.co.za" }, profile: { services: ["Plumbing"] } } };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })));
    await expect(readCrmProfile("co-1", client)).resolves.toMatchObject({ name: "Acme", services: ["Plumbing"] });
  });
});
