/**
 * 0.8.0: what `setup` wires up. Each piece is tested on its own elsewhere; this proves the worker actually subscribes to, registers
 * and exposes them: the client-answers job, the new tools and actions, the CRM's client-project links, the connect-account ask
 * effect, the POPIA erasure receiver, and exactly one company.created handler (the kit contract).
 */
import { describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { askEffectKeys, clearAskEffects } from "@partnersinbiz/pib-plugin-kit";
import { CONNECT_EFFECT_KEY } from "../src/connect-requests.js";
import manifest from "../src/manifest.js";
import plugin, { companyUsesSocial } from "../src/worker.js";
import { SOCIAL_TOOLS } from "../src/tools.js";

async function boot() {
  clearAskEffects();
  const harness = createTestHarness({ manifest, config: { publicBaseUrl: "https://paperclip.partnersinbiz.online" } });
  harness.seed({ companies: [{ id: "co-1", issuePrefix: "PIB", name: "PiB" } as never] });
  const subscribed: string[] = [];
  const emitted: Array<{ name: string; companyId: string; payload: Record<string, unknown> }> = [];
  const ctx = harness.ctx;
  const on = ctx.events.on.bind(ctx.events) as (...args: unknown[]) => unknown;
  (ctx.events as { on: unknown }).on = (...args: unknown[]) => {
    subscribed.push(String(args[0]));
    return on(...args);
  };
  const emit = ctx.events.emit.bind(ctx.events);
  (ctx.events as { emit: unknown }).emit = async (name: string, companyId: string, payload: Record<string, unknown>) => {
    emitted.push({ name, companyId, payload });
    return emit(name as never, companyId, payload as never);
  };
  await plugin.definition.setup(ctx);
  return { harness, subscribed, emitted };
}

describe("setup", () => {
  it("exposes every tool the manifest declares, including the 0.8.0 ones", async () => {
    const { harness } = await boot();
    for (const name of ["get-approval-policy", "get-approval-status", "request-client-approval", "record-review-verdict", "review-outcomes", "list-issue-attachments", "import-media-from-attachment"]) {
      expect(SOCIAL_TOOLS.map((t) => t.name)).toContain(name);
      expect(manifest.tools!.map((t) => t.name)).toContain(name);
      // Registered: an executed tool answers (here with an error, since the harness has no host database), it is never "not registered".
      const result = await harness.executeTool(name, { postId: "p1", issueId: "i1", attachmentId: "a1", verdict: "pass" }, { companyId: "co-1", agentId: "ag-1", runId: "run-1", projectId: "pr-1" });
      expect(JSON.stringify(result), name).not.toMatch(/not registered|unknown tool/i);
    }
  });

  it("registers the client-answers job (every 5 minutes) and runs it", async () => {
    const { harness } = await boot();
    expect(manifest.jobs!.find((j) => j.jobKey === "client-answers")).toMatchObject({ schedule: "*/5 * * * *" });
    // The harness namespace is not a host namespace, so the job fails on its first query: it ran, and the failure is recorded.
    await expect(harness.runJob("client-answers")).rejects.toThrow("Unsafe identifier");
  });

  it("the hourly skill sweep acts only for a company that can use Social: settings saved and the module not switched off", async () => {
    clearAskEffects();
    const saved = createTestHarness({ manifest, config: { publicBaseUrl: "https://paperclip.partnersinbiz.online" } });
    expect(await companyUsesSocial(saved.ctx, "co-1")).toBe(true);
    // No settings saved (a company that never set Social up): the host would refuse its skill sync, so it is left out of the sweep.
    const unsaved = createTestHarness({ manifest, config: {} });
    expect(await companyUsesSocial(unsaved.ctx, "co-2")).toBe(false);
  });

  it("has exactly one company.created handler and no core event subscribed twice", async () => {
    const { subscribed } = await boot();
    expect(subscribed.filter((name) => name === "company.created")).toHaveLength(1);
    const core = subscribed.filter((name) => !name.startsWith("plugin."));
    expect(new Set(core).size).toBe(core.length);
    // The bootstrap's lazy events, the hire watch, the done-checks.
    expect(core).toEqual(expect.arrayContaining(["company.created", "company.updated", "project.created", "issue.updated"]));
  });

  it("subscribes to the CRM's client-project links, the cockpit's answered asks and the CRM's erasure requests", async () => {
    const { subscribed } = await boot();
    expect(subscribed).toEqual(expect.arrayContaining([
      "plugin.partnersinbiz.crm.client.projects.updated",
      "plugin.partnersinbiz.cockpit.ask.answered",
      "plugin.partnersinbiz.crm.contact.erase.requested",
    ]));
  });
});

describe("the events do their work", () => {
  it("keeps the CRM's list of a client's projects", async () => {
    const { harness } = await boot();
    await harness.emit("plugin.partnersinbiz.crm.client.projects.updated", { clientKind: "company", clientRef: "c1", projectIds: ["proj-acme"], updatedAt: "2026-10-03T08:00:00Z" }, { companyId: "co-1" });
    expect(harness.getState({ scopeKind: "company", scopeId: "co-1", namespace: "pib-kit", stateKey: "client-projects:company:c1" })).toEqual({ projectIds: ["proj-acme"], updatedAt: "2026-10-03T08:00:00Z" });
  });

  it("registers the connect-account effect, and an answer nobody gave is refused, never run", async () => {
    const { harness, emitted } = await boot();
    expect(askEffectKeys()).toContain(CONNECT_EFFECT_KEY);
    await harness.emit("plugin.partnersinbiz.cockpit.ask.answered", {
      key: "ask:a1:t", askId: "a1", issueId: "iss-5", kind: "grant", effect: { key: CONNECT_EFFECT_KEY, params: { platform: "facebook", client: "own" } },
      question: "Connect Facebook?", options: [], answer: "Yes", answeredByUserId: "", answeredAt: "2026-10-03T08:00:00Z",
    }, { companyId: "co-1" });
    expect(emitted.find((e) => e.name === "ask.effect.result")?.payload).toMatchObject({ askId: "a1", effectKey: CONNECT_EFFECT_KEY, plugin: "partnersinbiz.social", status: "refused" });
  });

  it("answers an erasure request from the CRM, and refuses one no person approved", async () => {
    const { harness, emitted } = await boot();
    const base = { requestId: "r1", subject: { email: "sam@acme.test" }, scope: "all", reason: "data_subject_request", requestedAt: "2026-10-03T08:00:00Z", source: "partnersinbiz.crm" };
    await harness.emit("plugin.partnersinbiz.crm.contact.erase.requested", { ...base, approvedByUserId: "" }, { companyId: "co-1" });
    expect(emitted.find((e) => e.name === "contact.erase.completed")?.payload).toMatchObject({ requestId: "r1", plugin: "partnersinbiz.social", status: "failed", error: expect.stringContaining("Not approved by a person") });
  });
});

describe("manifest", () => {
  it("declares the capabilities 0.8.0 uses: issue attachments (new) and project reads (new)", () => {
    expect(manifest.capabilities).toEqual(expect.arrayContaining(["issue.attachments.read", "projects.read", "issues.update", "issues.wakeup", "issue.comments.create", "events.emit", "events.subscribe"]));
    // The Cockpit-facing and Setup-facing routes keep working.
    expect(manifest.apiRoutes!.map((r) => r.routeKey)).toEqual(["oauth-complete", "client-summary", "setup-status", "cockpit"]);
  });

  it("offers the approval page address as a setting, https, with a default", () => {
    const schema = manifest.instanceConfigSchema as { properties: Record<string, { description?: string; type?: string }> };
    expect(schema.properties.approvalBaseUrl).toMatchObject({ type: "string" });
    expect(schema.properties.approvalBaseUrl!.description).toContain("https://preview.partnersinbiz.online/a");
  });

  it("refuses a non-https approval page address at save time, and still allows leaving it empty for the default", () => {
    const schema = manifest.instanceConfigSchema as { properties: Record<string, { pattern?: string }> };
    const pattern = new RegExp(schema.properties.approvalBaseUrl!.pattern ?? "(?!)");
    expect(pattern.test("https://preview.partnersinbiz.online/a")).toBe(true);
    expect(pattern.test("")).toBe(true);
    for (const bad of ["preview.partnersinbiz.online/a", "http://preview.partnersinbiz.online/a", " https://x.test/a", "ftp://x.test"]) expect(pattern.test(bad)).toBe(false);
  });
});
