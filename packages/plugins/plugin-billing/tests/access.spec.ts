/**
 * The access guard of Billing (access stage A, spec PAR-12578 sections 4.4 to 4.6; PAR-12675): the kit's test helper
 * on the real plugin (registration, table, source, behaviour, agent and API route checks), the one-file rule for
 * `usePluginAction`, tools sharing their action's permission, and the API routes by URL: `client-summary` refused to
 * an operator with no grant under `enforce`, an unknown route key refused, and today's answers with the switch off.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { PluginApiRequestInput } from "@paperclipai/plugin-sdk";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { ADMIN_ONLY, accessCompanyScope, accessGrantScope, isRefusal } from "@partnersinbiz/pib-plugin-kit";
import { assertPluginAccess, ACCESS_TEST_IDS } from "@partnersinbiz/pib-plugin-kit/access-testing";
import manifest from "../src/manifest.js";
import plugin, { TOOL_ACTIONS } from "../src/worker.js";
import { ACCESS_TABLE, TOOL_ACTION_KEYS } from "../src/access-table.js";
import { BILLING_TOOLS } from "../src/tools.js";

const SRC = fileURLToPath(new URL("../src", import.meta.url));
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : /\.tsx?$/.test(name) ? [path] : [];
  });
const harnessOf = () => createTestHarness({ manifest, config: {} });

const CO = "a1500000-0000-4000-8000-0000000000aa";
const OWNER = "a1500000-0000-4000-8000-0000000000b1";
const OPERATOR = "a1500000-0000-4000-8000-0000000000b2";

/** A booted plugin on one company with the given switch, an owner and an operator with the given grant (none by default). */
async function boot(mode: "off" | "enforce", operatorAllows: string[] = []) {
  const harness = harnessOf();
  const at = new Date().toISOString();
  const member = (userId: string, role: string) => ({ id: `m-${userId}`, companyId: CO, principalType: "user" as const, principalId: userId, status: "active" as const, membershipRole: role, grants: [], createdAt: at, updatedAt: at });
  harness.seed({ accessMembers: [member(OWNER, "owner"), member(OPERATOR, "member")] as never });
  await harness.ctx.state.set(accessCompanyScope(CO), { mode, rev: 1, userIds: [], receivedAt: at });
  if (operatorAllows.length) await harness.ctx.state.set(accessGrantScope(CO, OPERATOR), { allow: operatorAllows, deny: [], scopeOverrides: { billing: "all" } });
  await plugin.definition.setup(harness.ctx);
  return harness;
}

const route = (routeKey: string, userId: string, extra: Partial<PluginApiRequestInput> = {}): PluginApiRequestInput => ({
  routeKey,
  method: "GET",
  path: `/${routeKey}`,
  params: {},
  query: { companyId: CO, kind: "company", id: "crm-1" },
  body: null,
  actor: { actorType: "user", actorId: userId, userId },
  companyId: CO,
  headers: {},
  ...extra,
});

describe("Billing access guard", () => {
  it("every action, tool and API route goes through the guard and the table; switch off passes, enforce refuses (4.5 items 1 to 6)", async () => {
    await assertPluginAccess({
      harness: harnessOf(),
      setup: plugin.definition.setup,
      onApiRequest: plugin.definition.onApiRequest!,
      manifest,
      table: ACCESS_TABLE,
      srcDir: SRC,
    });
  });

  it("only src/ui/actions.ts imports usePluginAction; every other page file uses the wrapped hook", () => {
    const direct = files(join(SRC, "ui"))
      .filter((f) => relative(SRC, f) !== join("ui", "actions.ts"))
      .filter((f) => /\busePluginAction\b/.test(readFileSync(f, "utf8")))
      .map((f) => relative(SRC, f));
    expect(direct).toEqual([]);
  });

  it("no entry is scoped yet, every row names a Billing resource, and the table's ADMIN_ONLY is the kit's", () => {
    for (const [key, entry] of Object.entries(ACCESS_TABLE)) {
      if (typeof entry !== "object" || !("resource" in entry)) continue;
      expect(entry.resource, key).toMatch(/^billing\.(invoices|quotes|expenses|bills|time|plans|reports|settings)$/);
      expect(entry.scoped, key).toBeUndefined();
    }
    expect(ACCESS_TABLE["billing.preferences-save"]).toBe(ADMIN_ONLY);
    expect(ACCESS_TABLE["api:client-summary"]).toEqual({ resource: "billing.invoices", action: "view" });
    expect(ACCESS_TABLE["api:invoice-grant"]).toEqual({ resource: "billing.invoices", action: "approve" });
  });

  it("each agent tool has the permission of the action it runs", () => {
    expect(Object.keys(TOOL_ACTION_KEYS).sort()).toEqual(BILLING_TOOLS.map((t) => t.name).sort());
    for (const [tool, { action }] of Object.entries(TOOL_ACTIONS)) {
      expect(TOOL_ACTION_KEYS[tool], tool).toBe(action);
      expect(ACCESS_TABLE[`tool:${tool}`], tool).toEqual(ACCESS_TABLE[action]);
    }
  });
});

describe("Billing actions that reach a client with no further approval need billing.invoices:approve", () => {
  const operator = { companyId: CO, actor: { type: "user" as const, userId: OPERATOR } };
  const reached = async (call: Promise<unknown>) => {
    const answer = await call.catch((error: unknown) => ({ threw: String(error) }));
    expect(isRefusal(answer), JSON.stringify(answer)).toBe(false);
    return answer;
  };

  it("retry-send: an operator with invoices edit but not approve is refused under enforce; with approve it reaches the handler", async () => {
    expect(ACCESS_TABLE["billing.retry-send"]).toEqual({ resource: "billing.invoices", action: "approve" });
    const editOnly = await boot("enforce", ["billing.invoices:view", "billing.invoices:edit"]);
    expect(isRefusal(await editOnly.performAction("billing.retry-send", {}, operator))).toBe(true);
    const approver = await boot("enforce", ["billing.invoices:approve"]);
    expect(await reached(approver.performAction("billing.retry-send", {}, operator))).toMatchObject({ threw: expect.stringMatching(/kind is required/) });
  });

  it("autoSend: plans create alone may create a subscription but not turn on automatic sending under enforce", async () => {
    const plansOnly = await boot("enforce", ["billing.plans:create"]);
    const refused = await plansOnly.performAction("billing.create-subscription", { autoSend: true }, operator);
    expect(isRefusal(refused) && refused.message).toMatch(/automatic sending needs billing\.invoices approve/);
    expect(await reached(plansOnly.performAction("billing.create-subscription", { autoSend: false }, operator))).toMatchObject({ threw: expect.stringMatching(/client is required/) });
    const approver = await boot("enforce", ["billing.plans:create", "billing.invoices:approve"]);
    expect(await reached(approver.performAction("billing.create-subscription", { autoSend: true }, operator))).toMatchObject({ threw: expect.stringMatching(/client is required/) });
    const off = await boot("off");
    expect(await reached(off.performAction("billing.create-subscription", { autoSend: true }, operator))).toMatchObject({ threw: expect.stringMatching(/client is required/) });
  });
  it("update-recurring: repointing an auto-send schedule needs invoices approve; a manual schedule or approver is fine", async () => {
    const rowOf = (autoSend: boolean) => ({ id: "r1", company_id: CO, template_invoice_id: "inv-old", auto_send: autoSend });
    const attempt = async (allows: string[], autoSend: boolean) => {
      const h = await boot("enforce", allows);
      Object.assign(h.ctx.db, { namespace: "plugin_billing_test", query: async () => [rowOf(autoSend)] });
      return h.performAction("billing.update-recurring", { recurringId: "r1", templateInvoiceId: "inv-new" }, operator);
    };
    const refused = await attempt(["billing.plans:edit"], true);
    expect(isRefusal(refused) && refused.message).toMatch(/needs billing\.invoices approve/);
    expect(isRefusal(await attempt(["billing.plans:edit"], false))).toBe(false);
    expect(isRefusal(await attempt(["billing.plans:edit", "billing.invoices:approve"], true))).toBe(false);
  });
});

describe("Billing API routes by URL", () => {
  it("client-summary as an operator with no grant under enforce is refused (403, the refusal form)", async () => {
    await boot("enforce");
    const answer = await plugin.definition.onApiRequest!(route("client-summary", OPERATOR));
    expect(answer.status).toBe(403);
    expect(isRefusal(answer.body)).toBe(true);
  });

  it("an unknown Billing route key under enforce is refused, the owner too", async () => {
    await boot("enforce");
    const answer = await plugin.definition.onApiRequest!(route("no-such-route", OWNER));
    expect(answer.status).toBe(403);
    expect(isRefusal(answer.body)).toBe(true);
  });

  it("client-summary as the owner under enforce gives today's answer", async () => {
    await boot("enforce");
    const answer = await plugin.definition.onApiRequest!(route("client-summary", OWNER));
    expect(answer.status).not.toBe(403);
    expect(isRefusal(answer.body)).toBe(false);
  });

  it("with the switch off an unknown route answers as before (404 Not found), not a refusal", async () => {
    await boot("off");
    const answer = await plugin.definition.onApiRequest!(route("no-such-route", OPERATOR));
    expect(answer).toEqual({ status: 404, body: { error: "Not found" } });
  });

  it("with the switch off invoice-grant still reaches the grant handler (its own 400 for a missing body)", async () => {
    await boot("off");
    const answer = await plugin.definition.onApiRequest!(route("invoice-grant", OPERATOR, { method: "POST", body: {} }));
    expect(answer).toEqual({ status: 400, body: { error: "invoiceId and granteeCompanyId are required" } });
  });
});

describe("the test companies", () => {
  it("do not clash with the kit helper's seeded ids", () => {
    expect(Object.values(ACCESS_TEST_IDS)).not.toContain(CO);
  });
});
