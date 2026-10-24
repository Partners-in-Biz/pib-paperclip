/**
 * Company preferences for SEO (timezone, daily run hour, default autopilot): precedence, PAR unchanged, the daily gate,
 * the owner/admin gate through the real manifest capabilities, and no hard-coded PiB text for other companies.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { describePreferences } from "@partnersinbiz/pib-plugin-kit";
import { loadSeoConfig, parseSeoConfig } from "../src/config.js";
import { playbookTitle } from "../src/engine/playbook.js";
import manifest from "../src/manifest.js";
import { companyDisplayName, SEO_PREFERENCES } from "../src/preferences.js";
import { draftProgressReport } from "../src/service/report.js";
import { companyInfo } from "../src/service/common.js";
import { runDailyJob } from "../src/service/jobs.js";
import plugin from "../src/worker.js";
import { SPRINT, seoHost, sprintRoutes } from "./helpers/seo-host.js";

const CO = "co-1";
const scopeOf = (companyId: string) => ({ scopeKind: "company" as const, scopeId: companyId, namespace: "preferences", stateKey: "v1" });
const member = (principalId: string, membershipRole: string) =>
  ({ id: `${CO}:${principalId}`, companyId: CO, principalType: "user", principalId, status: "active", membershipRole, grants: [] }) as never;

async function boot(opts: { config?: Record<string, unknown>; capabilities?: string[] } = {}) {
  const harness = createTestHarness({
    manifest,
    ...(opts.capabilities ? { capabilities: opts.capabilities as never } : {}),
    config: opts.config ?? { publicBaseUrl: "https://paperclip.example.com" },
  });
  harness.seed({
    companies: [{ id: CO, name: "Acme Co", issuePrefix: "ACM" } as never],
    accessMembers: [member("u-owner", "owner"), member("u-admin", "admin"), member("u-viewer", "viewer")],
  });
  await plugin.definition.setup(harness.ctx);
  const save = (userId: string, patch: unknown, type = "user") =>
    harness.performAction<{ ok: boolean; error?: string; values?: Record<string, unknown>; previous?: Record<string, unknown> }>(
      "seo.preferences-save",
      { patch } as Record<string, unknown>,
      { companyId: CO, actor: { type: type as never, userId } },
    );
  const load = () => harness.performAction<{ fields: Array<{ id: string }>; values: Record<string, unknown> }>("seo.preferences-load", {}, { companyId: CO, actor: { type: "user", userId: "u-viewer" } });
  return { harness, save, load };
}

describe("manifest and capability", () => {
  it("declares access.members.read while the worker registers seo.preferences-save", () => {
    const worker = readFileSync(new URL("../src/worker.ts", import.meta.url), "utf8");
    expect(worker).toContain('"seo.preferences-save"');
    expect(manifest.capabilities).toContain("access.members.read");
    expect(manifest.capabilities).toContain("companies.read");
  });

  it("registers both actions", async () => {
    const { harness } = await boot();
    expect(await harness.performAction("seo.preferences-load", {}, { companyId: CO })).toHaveProperty("fields");
  });
});

describe("precedence: row, then the saved host-form value, then the default", () => {
  it("uses the old defaults with no row and nothing saved", async () => {
    const { load } = await boot({ config: {} });
    expect((await load()).values).toEqual({ timezone: "Africa/Johannesburg", dailyHourLocal: 6, defaultAutopilotMode: "safe" });
  });

  it("uses a saved host-form value over the default, and the row over both", async () => {
    const { harness, load } = await boot({ config: { timezone: "Europe/London", dailyHourLocal: "9", defaultAutopilotMode: "off" } });
    expect((await load()).values).toEqual({ timezone: "Europe/London", dailyHourLocal: 9, defaultAutopilotMode: "off" });
    await harness.ctx.state.set(scopeOf(CO), { values: { dailyHourLocal: 14 }, updatedBy: "u", updatedAt: "t" });
    expect((await load()).values).toEqual({ timezone: "Europe/London", dailyHourLocal: 14, defaultAutopilotMode: "off" });
  });

  it("ignores an invalid host-form value, as before", async () => {
    const { load } = await boot({ config: { timezone: "Mars/Olympus", dailyHourLocal: 99, defaultAutopilotMode: "wild" } });
    expect((await load()).values).toEqual({ timezone: "Africa/Johannesburg", dailyHourLocal: 6, defaultAutopilotMode: "safe" });
  });
});

describe("PAR is unchanged", () => {
  const raws: Array<Record<string, unknown>> = [
    {},
    { publicBaseUrl: "https://paperclip.example.com" },
    { publicBaseUrl: "https://paperclip.example.com", timezone: "Africa/Johannesburg", dailyHourLocal: 6, defaultAutopilotMode: "safe" },
    { timezone: "Europe/London", dailyHourLocal: 0, defaultAutopilotMode: "full" },
    { dailyHourLocal: "7" },
    { timezone: "Nowhere/Land", dailyHourLocal: 24, defaultAutopilotMode: "x" },
  ];
  it.each(raws.map((raw, i) => [i, raw] as const))("loadSeoConfig matches the host-form parse for saved config #%i when no row exists", async (_i, raw) => {
    const harness = createTestHarness({ manifest, config: raw });
    harness.seed({ companies: [{ id: CO, name: "Partners in Biz", issuePrefix: "PAR" } as never] });
    const loaded = await loadSeoConfig(harness.ctx, CO);
    const before = parseSeoConfig(raw);
    expect(loaded.config).toEqual(before);
    expect(loaded.config.saved).toBe(Object.keys(raw).length > 0);
  });

  it("keeps the host-form values when the preferences read fails", async () => {
    const harness = createTestHarness({ manifest, config: { timezone: "Europe/London", dailyHourLocal: 8 } });
    (harness.ctx.state as { get: unknown }).get = async () => {
      throw new Error("state unavailable");
    };
    const { config } = await loadSeoConfig(harness.ctx, CO);
    expect(config).toMatchObject({ timezone: "Europe/London", dailyHourLocal: 8, defaultAutopilotMode: "safe" });
  });

  it("signs PAR's emails with the company name, which is what the literal said", async () => {
    const { ctx } = seoHost();
    (ctx.companies as { get: unknown }).get = async () => ({ id: CO, name: "Partners in Biz", issuePrefix: "PAR" });
    expect(await companyDisplayName(ctx, CO)).toBe("Partners in Biz");
    expect(playbookTitle(null, null, await companyDisplayName(ctx, CO))).toBe("Partners in Biz");
  });
});

describe("the daily job gates on the preference", () => {
  const runnable = [/FROM plugin_seo_8099f8879a\.sprints\s+WHERE status IN/, () => [SPRINT]] as [RegExp, () => Array<Record<string, unknown>>];

  it("skips a company whose preferred hour has not come, with no host-form change", async () => {
    // 2026-10-03T10:00Z is 12:00 in Africa/Johannesburg.
    const h = seoHost({ now: "2026-10-03T10:00:00Z", routes: [runnable, ...sprintRoutes] });
    h.state.set("v1", { values: { dailyHourLocal: 23 }, updatedBy: "u", updatedAt: "t" });
    expect((await companyInfo(h.env, CO)).loaded.config.dailyHourLocal).toBe(23);
    const result = await runDailyJob(h.env);
    expect(result).toMatchObject({ processed: 0, skipped: 1, errors: [] });
  });

  it("follows the preferred timezone for the hour", async () => {
    const h = seoHost({ now: "2026-10-03T10:00:00Z", routes: sprintRoutes });
    h.state.set("v1", { values: { timezone: "Pacific/Auckland" }, updatedBy: "u", updatedAt: "t" });
    const info = await companyInfo(h.env, CO);
    expect(info.timezone).toBe("Pacific/Auckland");
    expect(info.hour).toBe(23);
  });
});

describe("saving", () => {
  it("lets an owner and an admin save, and returns the previous values", async () => {
    const { save, load } = await boot();
    const first = await save("u-owner", { dailyHourLocal: 8, timezone: "Europe/London" });
    expect(first).toMatchObject({ ok: true, values: { dailyHourLocal: 8, timezone: "Europe/London" }, previous: { dailyHourLocal: 6 } });
    expect((await save("u-admin", { defaultAutopilotMode: "full" })).ok).toBe(true);
    expect((await load()).values).toEqual({ timezone: "Europe/London", dailyHourLocal: 8, defaultAutopilotMode: "full" });
  });

  it("refuses a viewer, a non-member, an agent and a missing company, writing nothing", async () => {
    const { harness, save } = await boot();
    expect((await save("u-viewer", { dailyHourLocal: 9 })).ok).toBe(false);
    expect((await save("u-stranger", { dailyHourLocal: 9 })).ok).toBe(false);
    expect((await save("agent-1", { dailyHourLocal: 9 }, "agent")).ok).toBe(false);
    const noCompany = await harness.performAction<{ ok: boolean }>("seo.preferences-save", { patch: { dailyHourLocal: 9 } }, { companyId: null, actor: { type: "user", userId: "u-owner" } }).catch(() => ({ ok: false }));
    expect(noCompany.ok).toBe(false);
    expect(harness.getState(scopeOf(CO))).toBeFalsy();
  });

  it("refuses when the capability is missing, instead of failing open", async () => {
    const { harness, save } = await boot({ capabilities: manifest.capabilities.filter((c) => c !== "access.members.read") });
    const result = await save("u-owner", { dailyHourLocal: 9 });
    expect(result).toMatchObject({ ok: false, error: "Cannot verify your role" });
    expect(harness.getState(scopeOf(CO))).toBeFalsy();
  });

  it("refuses an unknown timezone, an hour out of range and unknown fields", async () => {
    const { save } = await boot();
    expect((await save("u-owner", { timezone: "Mars/Olympus" })).error).toMatch(/timezone/i);
    expect((await save("u-owner", { dailyHourLocal: 24 })).ok).toBe(false);
    expect((await save("u-owner", { defaultAutopilotMode: "wild" })).ok).toBe(false);
    expect((await save("u-owner", { encryptionKey: "x" })).ok).toBe(false);
  });
});

describe("no PiB text for other companies", () => {
  it("has no PiB wording in any preference label, help or default", () => {
    expect(JSON.stringify(describePreferences(SEO_PREFERENCES))).not.toMatch(/PiB|Partners in Biz/i);
  });

  it("signs, titles and labels with the company's own name, or neutral wording", async () => {
    const { ctx } = seoHost();
    (ctx.companies as { get: unknown }).get = async () => ({ id: CO, name: "Acme Co", issuePrefix: "ACM" });
    expect(await companyDisplayName(ctx, CO)).toBe("Acme Co");
    (ctx.companies as { get: unknown }).get = async () => {
      throw new Error("refused");
    };
    expect(await companyDisplayName(ctx, CO)).toBe("Your SEO team");
  });

  it("signs the progress email draft with the company name", async () => {
    const h = seoHost({ routes: sprintRoutes });
    (h.ctx.companies as { get: unknown }).get = async () => ({ id: CO, name: "Acme Co", issuePrefix: "ACM" });
    const result = (await draftProgressReport(h.env, CO, { kind: "system" }, { sprintIds: ["sp-1"], to: ["a@example.com"] })) as { preview: string };
    expect(result.preview).toContain("Kind regards,\nAcme Co");
    expect(result.preview).not.toMatch(/Partners in Biz/);
  });

  it.each(["src/engine/playbook.ts", "src/service/playbook.ts", "src/service/report.ts", "src/service/client-signoff.ts"])("%s has no hard-coded PiB name", (file) => {
    expect(readFileSync(new URL(`../${file}`, import.meta.url), "utf8")).not.toMatch(/Partners in Biz|\bPiB\b/);
  });
});
