/**
 * The access guard of the CRM (access stage A, spec PAR-12578 sections 4.4 and 4.5; PAR-12679): the kit's test helper on
 * the real plugin (registration, table, source, behaviour, agent and API route checks), the table's own rules, today's
 * answer with the switch off, and a real handler behind the guard under `enforce`. Part 2 (PAR-12680, section 4.6): the
 * page gate on every manifest slot and the one `withRefusal` hook file.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { accessCompanyScope, ADMIN_ONLY, isRefusal, PERMISSION_CATALOG, PERMISSION_DENIED } from "@partnersinbiz/pib-plugin-kit";
import { assertPluginAccess, ACCESS_TEST_IDS, NAMED_DATA_HANDLERS } from "@partnersinbiz/pib-plugin-kit/access-testing";
import { AccessRefused, checkAccess, unwrapRefusal } from "@partnersinbiz/pib-plugin-ui";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";
import { ACCESS_TABLE, SHARED_ROWS } from "../src/access-table.js";
import { boot, CO } from "./helpers/crm.js";

const SRC = fileURLToPath(new URL("../src", import.meta.url));
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : /\.tsx?$/.test(name) ? [path] : [];
  });
/** The source of a top-level `function name(` up to its closing brace at column 0. */
const functionBody = (source: string, name: string): string => {
  const start = source.search(new RegExp(`^(export )?function ${name}\\(`, "m"));
  expect(start, name).toBeGreaterThanOrEqual(0);
  return source.slice(start, source.indexOf("\n}\n", start));
};

describe("CRM access guard", () => {
  it("every action, tool and API route goes through the guard and the table; switch off passes, enforce refuses (4.5 items 1 to 6)", async () => {
    const harness = createTestHarness({ manifest, config: { timezone: "Africa/Johannesburg" } });
    await assertPluginAccess({
      harness,
      setup: plugin.definition.setup,
      onApiRequest: plugin.definition.onApiRequest!,
      manifest,
      table: ACCESS_TABLE,
      srcDir: SRC,
    });
  });

  it("the CRM has no data handler: the two Drive reads are the actions crm.drive-folder and crm.drive-files (stage B-3)", () => {
    expect(NAMED_DATA_HANDLERS[manifest.id]).toBeUndefined();
    expect(ACCESS_TABLE["crm.drive-folder"]).toEqual({ resource: "crm.drive", action: "view", scoped: true });
    expect(ACCESS_TABLE["crm.drive-files"]).toEqual({ resource: "crm.drive", action: "view", scoped: true });
  });

  it("every row names a CRM catalog resource and one of its actions; only the stage B-2 and B-3 rows are scoped", () => {
    const catalog = new Map(PERMISSION_CATALOG.map((r) => [r.id, r]));
    const scoped: string[] = [];
    for (const [key, entry] of Object.entries(ACCESS_TABLE)) {
      if (typeof entry !== "object" || !("resource" in entry)) continue;
      expect(entry.resource, key).toMatch(/^crm\./);
      expect(catalog.get(entry.resource)?.actions, key).toContain(entry.action);
      if (entry.scoped) scoped.push(key);
    }
    // Stage B-2 (PAR-15204): companies, contacts, deals, the desk and their lists (tests/access-scoping.spec.ts).
    const both = (names: string[]) => names.flatMap((name) => [`crm.${name}`, `tool:${name}`]);
    const b2 = [
      ...both([
        "find-records", "bulk-tag-contacts", "update-company", "update-client-profile", "log-activity", "update-contact", "link-contact",
        "set-email-status", "score-contact", "export-person-data", "request-erasure", "move-deal", "update-deal", "call-list", "log-outcome",
        "set-next-action", "create-company",
      ]),
      "crm.load", "crm.client-workspace", "crm.activities", "canvas.cards.resolve", "canvas.cards.search", "canvas.cards.related",
      "crm.set-human-owned", "crm.desk",
      ...["get-company", "get-client-profile", "field-history", "get-contact", "contact-graph", "find-duplicates", "export-contacts", "list-deals", "list-stages", "list-deal-products", "add-deal-product"].map((name) => `tool:${name}`),
    ];
    // Stage B-3 (PAR-15205; tests/access-scoping-clients.spec.ts): every row of the client areas (sites incl. wp-* and
    // lead forms and event keys, e-sign, care, projects, Drive) but Drive trash, and the client's profile, sensitivity,
    // channel costs and leads.
    const CLIENT_AREAS = ["crm.sites", "crm.esign", "crm.care", "crm.projects", "crm.drive"];
    const b3 = [
      ...Object.entries(ACCESS_TABLE)
        .filter(([key, entry]) => typeof entry === "object" && "resource" in entry && CLIENT_AREAS.includes(entry.resource) && key !== "tool:drive_file_trash")
        .map(([key]) => key),
      ...both(["extract-brand-from-site", "set-client-sensitivity", "record-channel-cost", "record-lead-outcome", "list-client-leads"]),
    ];
    expect(scoped.sort()).toEqual([...b2, ...b3].sort());
    expect(b3).toEqual(expect.arrayContaining(["crm.drive-folder", "crm.drive-files", "tool:wp-seo", "crm.wp-content", "tool:drive_file_save", "tool:list-client-sites", "tool:list-sign-documents", "tool:list-support-cases"]));
    // Reports (attribution and site events too), settings, sequences, creates, deletes, shares, consent and Drive trash stay closed.
    for (const key of [
      "crm.reports-drive-catchup", "tool:pipeline-forecast", "crm.settings-status", "tool:create-pipeline", "crm.share-record", "crm.delete-company",
      "tool:merge-contacts", "crm.sequence-detail", "tool:attribution-report", "crm.site-events-report", "tool:record-consent", "tool:start-new-client", "tool:drive_file_trash",
      "tool:drive_binding_set",
    ]) {
      expect((ACCESS_TABLE[key] as { scoped?: true }).scoped, key).toBeUndefined();
    }
  });

  it("names the rows the spec fixes: client-workspace is companies view; hiring, maintenance and the partner share are ADMIN_ONLY", () => {
    expect(ACCESS_TABLE["crm.client-workspace"]).toEqual({ resource: "crm.companies", action: "view", scoped: true });
    for (const key of ["crm.hire-options", "crm.start-hire", "crm.link-agent", "crm.unlink-agent", "crm.resync-agent", "crm.sync-skills", "crm.resync", "api:record-grant", "tool:cleanup-canary"]) {
      expect(ACCESS_TABLE[key], key).toBe(ADMIN_ONLY);
    }
  });

  it("a tool and the page action of the same name have the same row", () => {
    for (const [key, entry] of Object.entries(ACCESS_TABLE)) {
      if (!key.startsWith("tool:")) continue;
      const action = `crm.${key.slice(5)}`;
      if (Object.hasOwn(ACCESS_TABLE, action)) expect(ACCESS_TABLE[action], action).toEqual(entry);
    }
    for (const name of Object.keys(SHARED_ROWS)) {
      expect(ACCESS_TABLE[`crm.${name}`], name).toBeDefined();
      expect(ACCESS_TABLE[`tool:${name}`], name).toBeDefined();
    }
  });

  it("with the switch off an unknown route answers as before (404), not a refusal", async () => {
    const harness = createTestHarness({ manifest, config: { timezone: "Africa/Johannesburg" } });
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
    expect(answer).toEqual({ status: 404, body: { error: "Not found" } });
  });
});

describe("CRM pages behind the gate (4.6, PAR-12680)", () => {
  it("only src/ui/actions.ts mentions usePluginAction, and its page hook is the UI kit's withRefusal", () => {
    const direct = files(join(SRC, "ui"))
      .filter((f) => relative(SRC, f) !== join("ui", "actions.ts"))
      .filter((f) => /\busePluginAction\b/.test(readFileSync(f, "utf8")))
      .map((f) => relative(SRC, f));
    expect(direct).toEqual([]);
    expect(readFileSync(join(SRC, "ui", "actions.ts"), "utf8")).toMatch(/export const useCrmAction = withRefusal\(usePluginAction\);/);
  });

  it("every page, sidebar and widget slot in the manifest is exported behind the page gate", () => {
    const index = readFileSync(join(SRC, "ui", "index.tsx"), "utf8");
    const slots = manifest.ui?.slots ?? [];
    expect(slots.length).toBeGreaterThan(0);
    for (const slot of slots) {
      // A canvas card has no page gate: the worker answers `canvas.cards.*` per record and the card draws any refusal as
      // "No access" (tests/canvas-cards.spec.ts).
      if (slot.type === "canvasNode") continue;
      const kind = slot.type === "sidebar" ? "sidebar" : slot.type === "page" ? "page" : "widget";
      // A page is `withHelp(<Name>Main)` (the help contract); the gate is the first thing that function renders.
      const name = slot.type === "page" ? `${slot.exportName}Main` : slot.exportName;
      if (slot.type === "page") expect(index).toContain(`export const ${slot.exportName} = withHelp(${name});`);
      const body = functionBody(index, name);
      expect(body, slot.exportName).toContain("useAccess(useAccessMe(), props.context.companyId)");
      expect(body, slot.exportName).toMatch(new RegExp(`<AccessGate state={access} kind="${kind}"`));
    }
  });
});

describe("a real CRM handler behind the guard", () => {
  const OWNER = "a1500000-0000-4000-8000-00000000c011";
  const OPERATOR = "a1500000-0000-4000-8000-00000000c012";

  it("switch absent: today's answer; enforce: the owner gets the same answer and a member with no grant the refusal form", async () => {
    const { harness } = await boot();
    const at = new Date().toISOString();
    const member = (userId: string, role: string) => ({ id: `m-${userId}`, companyId: CO, principalType: "user" as const, principalId: userId, status: "active" as const, membershipRole: role, grants: [], createdAt: at, updatedAt: at });
    harness.seed({ accessMembers: [member(OWNER, "owner"), member(OPERATOR, "member")] });
    const as = (userId: string) => ({ companyId: CO, actor: { type: "user" as const, userId } });
    const today = await harness.performAction("crm.settings-status", {}, as(OPERATOR));
    expect(isRefusal(today)).toBe(false);

    await harness.ctx.state.set(accessCompanyScope(CO), { mode: "enforce", rev: 1, userIds: [], receivedAt: at });
    await expect(harness.performAction("crm.settings-status", {}, as(OWNER))).resolves.toEqual(today);
    const refused = await harness.performAction("crm.settings-status", {}, as(OPERATOR));
    expect(isRefusal(refused) && refused.code).toBe(PERMISSION_DENIED);
  });

  async function crm(mode?: "off" | "enforce") {
    const { harness } = await boot();
    const at = new Date().toISOString();
    const member = (userId: string, role: string) => ({ id: `m-${userId}`, companyId: CO, principalType: "user" as const, principalId: userId, status: "active" as const, membershipRole: role, grants: [], createdAt: at, updatedAt: at });
    harness.seed({ accessMembers: [member(OWNER, "owner"), member(OPERATOR, "member")] });
    if (mode) await harness.ctx.state.set(accessCompanyScope(CO), { mode, rev: 1, userIds: [], receivedAt: at });
    const as = (userId: string) => ({ companyId: CO, actor: { type: "user" as const, userId } });
    return { harness, as };
  }

  it("page gate: open with the switch absent or off and for the owner; closed for an operator with no grant under enforce", async () => {
    const gate = async (mode: "off" | "enforce" | undefined, userId: string) => {
      const { harness, as } = await crm(mode);
      return checkAccess((params) => harness.performAction("access.me", params, as(userId)), CO);
    };
    expect(await gate(undefined, OPERATOR)).toBe("open");
    expect(await gate("off", OPERATOR)).toBe("open");
    expect(await gate("enforce", OWNER)).toBe("open");
    expect(await gate("enforce", OPERATOR)).toBe("closed");
  });

  it("a page action's refusal throws AccessRefused with the worker's message; the switch off and the owner pass the answer through", async () => {
    const { harness, as } = await crm("enforce");
    const refused = await harness.performAction("crm.load", {}, as(OPERATOR));
    expect(() => unwrapRefusal(refused)).toThrow(AccessRefused);
    expect(() => unwrapRefusal(refused)).toThrow((refused as { message: string }).message);
    const owner = await harness.performAction("crm.load", {}, as(OWNER));
    expect(unwrapRefusal(owner)).toBe(owner);
    const off = await crm("off");
    const today = await off.harness.performAction("crm.load", {}, off.as(OPERATOR));
    expect(isRefusal(today)).toBe(false);
    expect(unwrapRefusal(today)).toBe(today);
  });
});
