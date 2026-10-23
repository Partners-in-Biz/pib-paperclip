import { describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { adsConfigFrom, buildInstanceConfigSchema, platformStateOf } from "../src/config.js";
import manifest from "../src/manifest.js";

const ctx = () => createTestHarness({ manifest, config: {} }).ctx;

describe("a platform is off until it is switched on AND complete", () => {
  it("is off by default, whatever is saved", () => {
    expect(platformStateOf({}, "meta")).toMatchObject({ enabled: false, switchedOn: false });
    expect(platformStateOf({ platforms: { meta: { appId: "x", appSecret: "y".repeat(20) } } }, "meta")).toMatchObject({ enabled: false, switchedOn: false, signIn: true });
    expect(platformStateOf({ platforms: { google: { clientId: "x", clientSecret: "y".repeat(20) } } }, "google").enabled).toBe(false);
  });

  it("needs the keys even when switched on, and says what is missing", () => {
    const meta = platformStateOf({ platforms: { meta: { enabled: true } } }, "meta");
    expect(meta).toMatchObject({ enabled: false, switchedOn: true });
    expect(meta.blocker).toMatch(/app ID and secret.*system-user token/);
    const google = platformStateOf({ platforms: { google: { enabled: true, clientId: "c" } } }, "google");
    expect(google.enabled).toBe(false);
    expect(google.blocker).toMatch(/OAuth client ID and secret/);
    expect(platformStateOf({ platforms: { google: { enabled: true, clientId: "c", clientSecret: "s".repeat(20) } } }, "google")).toMatchObject({ enabled: true, blocker: null });
  });

  it("accepts a Meta system-user token instead of an app, and a secret reference as a secret", () => {
    const token = platformStateOf({ platforms: { meta: { enabled: true, systemUserToken: { type: "secret_ref", secretId: "sec-1" } } } }, "meta");
    expect(token).toMatchObject({ enabled: true, signIn: false, token: true });
    const ref = platformStateOf({ platforms: { meta: { enabled: true, appId: "a", appSecret: { type: "secret_ref", secretId: "sec-2" } } } }, "meta");
    expect(ref).toMatchObject({ enabled: true, signIn: true });
  });

  it("reads the write permission request and the version only when saved", () => {
    expect(platformStateOf({ platforms: { meta: { enabled: true, appId: "a", appSecret: "s".repeat(20), requestWrite: true, apiVersion: "v26.0" } } }, "meta")).toMatchObject({ requestWrite: true, apiVersion: "v26.0" });
    expect(platformStateOf({ platforms: { meta: { enabled: true, appId: "a", appSecret: "s".repeat(20) } } }, "meta").requestWrite).toBe(false);
    // Google has the same switch: its one sign-in permission reads and changes, so without the switch no Google connection could ever change ads.
    expect(platformStateOf({ platforms: { google: { enabled: true, clientId: "c", clientSecret: "g".repeat(20), requestWrite: true } } }, "google").requestWrite).toBe(true);
    expect(platformStateOf({ platforms: { google: { enabled: true, clientId: "c", clientSecret: "g".repeat(20) } } }, "google").requestWrite).toBe(false);
  });

  it("every platform setting the code reads is one the settings page can show (a setting nobody can switch on is a dead end)", () => {
    const platforms = (buildInstanceConfigSchema().properties as Record<string, any>).platforms.properties as Record<string, { properties: Record<string, unknown> }>;
    expect(Object.keys(platforms.meta!.properties)).toEqual(expect.arrayContaining(["enabled", "appId", "appSecret", "systemUserToken", "requestWrite", "apiVersion"]));
    expect(Object.keys(platforms.google!.properties)).toEqual(expect.arrayContaining(["enabled", "clientId", "clientSecret", "developerToken", "requestWrite", "apiVersion"]));
  });
});

describe("settings", () => {
  it("changes to ads are off unless the company switch is on", () => {
    expect(adsConfigFrom(ctx(), "co", {}).writesEnabled).toBe(false);
    expect(adsConfigFrom(ctx(), "co", { writes: { enabled: true } }).writesEnabled).toBe(true);
    expect(adsConfigFrom(ctx(), "co", { writes: { enabled: "yes" } }).writesEnabled).toBe(false);
  });

  it("is 'saved' only when something was saved, and keeps alert thresholds sane", () => {
    expect(adsConfigFrom(ctx(), "co", {}).saved).toBe(false);
    const c = adsConfigFrom(ctx(), "co", { publicBaseUrl: "https://p.test", alerts: { spikeFactor: 0.5, spikeMinMinor: -5, cpaTolerance: 0.4 } });
    expect(c.saved).toBe(true);
    expect(c.alerts).toMatchObject({ spikeFactor: 1.2, spikeMinMinor: 0, cpaTolerance: 0.4 });
  });

  it("builds the redirect address from the public address and the page's own base, and says what is missing", () => {
    const base = "/_plugins/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/ui/";
    expect(adsConfigFrom(ctx(), "co", { publicBaseUrl: "https://p.test/" }, base).redirectUri()).toBe("https://p.test/_plugins/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/ui/oauth-callback.html");
    expect(() => adsConfigFrom(ctx(), "co", { publicBaseUrl: "https://p.test" }, null).redirectUri()).toThrow(/Open the Ads page once/);
    expect(() => adsConfigFrom(ctx(), "co", {}, base).redirectUri()).toThrow(/Public base URL/);
    expect(() => adsConfigFrom(ctx(), "co", { publicBaseUrl: "http://p.test" }, base).redirectUri()).toThrow(/https/);
  });

  it("resolves secrets only for a platform that is usable, and never from a switched-off one", async () => {
    const config = adsConfigFrom(ctx(), "co", { platforms: { meta: { enabled: false, appId: "a", appSecret: "s".repeat(20) } } });
    await expect(config.app("meta")).rejects.toThrow(/switched off/);
    const on = adsConfigFrom(ctx(), "co", { platforms: { google: { enabled: true, clientId: "cid", clientSecret: "g".repeat(20), developerToken: "DEV".repeat(8) } } });
    expect(await on.app("google")).toMatchObject({ clientId: "cid", clientSecret: "g".repeat(20), developerToken: "DEV".repeat(8) });
  });

  it("refuses to seal anything without an encryption key", async () => {
    await expect(adsConfigFrom(ctx(), "co", {}).keyring()).rejects.toThrow(/encryption key is not set/);
    const keyed = await adsConfigFrom(ctx(), "co", { encryptionKey: "k".repeat(24) }).keyring();
    expect(keyed.currentVersion).toBe(1);
  });

  it("every secret field in the schema is a secret reference (no plain text secrets), and every platform starts off", () => {
    const schema = buildInstanceConfigSchema() as { properties: Record<string, any> };
    const secrets: string[] = [];
    const walk = (node: any, path: string) => {
      if (!node || typeof node !== "object") return;
      if (node.format === "secret-ref") secrets.push(path);
      for (const [k, v] of Object.entries(node.properties ?? {})) walk(v, `${path}.${k}`);
    };
    walk(schema, "");
    expect(secrets.sort()).toEqual([".encryptionKey", ".platforms.google.clientSecret", ".platforms.google.developerToken", ".platforms.meta.appSecret", ".platforms.meta.systemUserToken", ".previousEncryptionKey"]);
    for (const p of ["meta", "google", "mock"]) expect(schema.properties.platforms.properties[p].properties.enabled.default).toBe(false);
    expect(schema.properties.writes.properties.enabled.default).toBe(false);
  });
});
