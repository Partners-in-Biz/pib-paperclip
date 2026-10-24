import { describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import { campaignsPreferences, preferencesLoad, preferencesSave, readCampaignPreferences } from "../src/preferences.js";
import { clearMessagingCache, messagingSetup } from "../src/messaging.js";

const PAR = "co-par";
const CLIENT = "co-client";
const member = (companyId: string, principalId: string, membershipRole: string) =>
  ({ id: `${companyId}:${principalId}`, companyId, principalType: "user", principalId, status: "active", membershipRole, grants: [] }) as never;

function boot(config: Record<string, unknown> = {}, capabilities = manifest.capabilities) {
  const harness = createTestHarness({ manifest: { ...manifest, capabilities } as never, config });
  harness.seed({
    companies: [
      { id: PAR, name: "Partners in Biz", issuePrefix: "PAR" } as never,
      { id: CLIENT, name: "Acme Plumbing", issuePrefix: "ACM" } as never,
    ],
    accessMembers: [member(PAR, "u-owner", "owner"), member(CLIENT, "u-owner", "owner"), member(CLIENT, "u-viewer", "viewer")],
  });
  return harness.ctx;
}

describe("campaigns preferences", () => {
  it("a company with no config resolves neutral defaults with no PiB text", async () => {
    clearMessagingCache();
    const ctx = boot();
    const values = await readCampaignPreferences(ctx, CLIENT);
    expect(values).toEqual({ timezone: "Africa/Johannesburg", defaultFromName: "Acme Plumbing" });
    expect(JSON.stringify(values)).not.toMatch(/PiB|Partners in Biz/);
    expect((await preferencesLoad(ctx, CLIENT)).fields.map((f) => JSON.stringify(f)).join()).not.toMatch(/PiB|Partners in Biz/);
  });

  it("falls back to an explicitly saved host setting, and a saved preference wins over it", async () => {
    const ctx = boot({ timezone: "Africa/Cairo", defaultFromName: "Acme Heating" });
    expect(await readCampaignPreferences(ctx, CLIENT)).toEqual({ timezone: "Africa/Cairo", defaultFromName: "Acme Heating" });
    const saved = await preferencesSave(ctx, { companyId: CLIENT, actor: { type: "user", userId: "u-owner" } }, { defaultFromName: "Acme Plumbing Co" });
    expect(saved.ok).toBe(true);
    expect(await readCampaignPreferences(ctx, CLIENT)).toEqual({ timezone: "Africa/Cairo", defaultFromName: "Acme Plumbing Co" });
  });

  it("keeps PAR's old values: the pinned sender name, and its saved timezone", async () => {
    expect(await readCampaignPreferences(boot(), PAR)).toEqual({ timezone: "Africa/Johannesburg", defaultFromName: "Partners in Biz" });
    expect(await readCampaignPreferences(boot({ timezone: "Africa/Lagos", defaultFromName: "PiB Growth" }), PAR)).toEqual({ timezone: "Africa/Lagos", defaultFromName: "PiB Growth" });
  });

  it("the send window clock follows the preference", async () => {
    clearMessagingCache();
    const ctx = boot({ timezone: "Africa/Cairo" });
    expect((await messagingSetup(ctx, CLIENT, { fresh: true })).config.timezone).toBe("Africa/Cairo");
    await preferencesSave(ctx, { companyId: CLIENT, actor: { type: "user", userId: "u-owner" } }, { timezone: "Africa/Lagos" });
    expect((await messagingSetup(ctx, CLIENT, { fresh: true })).config.timezone).toBe("Africa/Lagos");
  });

  it("refuses a viewer and an agent, and never writes", async () => {
    const ctx = boot();
    expect((await preferencesSave(ctx, { companyId: CLIENT, actor: { type: "user", userId: "u-viewer" } }, { timezone: "UTC" })).ok).toBe(false);
    expect((await preferencesSave(ctx, { companyId: CLIENT, actor: { type: "agent", userId: null } }, { timezone: "UTC" })).ok).toBe(false);
    expect((await readCampaignPreferences(ctx, CLIENT)).timezone).toBe("Africa/Johannesburg");
  });

  it("fails if the manifest lacks access.members.read while preferences-save is registered", async () => {
    expect(manifest.capabilities).toContain("access.members.read");
    expect(manifest.capabilities).toContain("plugin.state.write");
    const source = (await import("node:fs")).readFileSync(new URL("../src/worker.ts", import.meta.url), "utf8");
    expect(source).toContain('"campaigns.preferences-save"');
    // Without the capability the save is refused, not written.
    const ctx = boot({}, manifest.capabilities.filter((c) => c !== "access.members.read"));
    const result = await preferencesSave(ctx, { companyId: CLIENT, actor: { type: "user", userId: "u-owner" } }, { timezone: "UTC" });
    expect(result).toMatchObject({ ok: false });
  });

  it("only exposes the two moved fields", () => {
    expect(Object.keys(campaignsPreferences.fields)).toEqual(["timezone", "defaultFromName"]);
  });
});
