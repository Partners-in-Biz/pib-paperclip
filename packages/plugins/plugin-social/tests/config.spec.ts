import { describe, expect, it, vi } from "vitest";
import { openJson, sealJson, TokenKeyError } from "@partnersinbiz/pib-plugin-kit";
import { loadSocialConfig } from "../src/config.js";
import { fakeCtx } from "./helpers.js";

const REF = (id: string) => ({ type: "secret_ref", secretId: id });

function ctxWith(config: Record<string, unknown>) {
  const get = vi.fn(async () => config);
  const resolve = vi.fn(async (ref: { secretId: string }) => ({
    enc: "a-very-long-encryption-key-123",
    fb: "facebook-secret",
    r2: "r2-secret",
    prev: "the-previous-long-key-456",
  })[ref.secretId] ?? "");
  const ctx = fakeCtx({ config: { get }, secrets: { resolve } });
  return { ctx, get, resolve };
}

const FULL = {
  publicBaseUrl: "https://paperclip.partnersinbiz.online/",
  encryptionKey: REF("enc"),
  timezone: "Africa/Johannesburg",
  linkedinOrgPages: true,
  platforms: {
    facebook: { clientId: "fb-id", clientSecret: REF("fb"), apiVersion: "v22.0" },
    linkedin: { clientId: "li-id" },
  },
  r2: { accountId: "acc", bucket: "media", accessKeyId: "AK", secretAccessKey: REF("r2"), publicMediaBaseUrl: "https://media.partnersinbiz.online/" },
};

describe("loadSocialConfig", () => {
  it("always reads the company's config and resolves secrets lazily with configPath", async () => {
    const { ctx, get, resolve } = ctxWith(FULL);
    const config = await loadSocialConfig(ctx, "co-1");
    expect(get).toHaveBeenCalledWith("co-1");
    expect(resolve).not.toHaveBeenCalled();
    expect(config.redirectUri()).toBe("https://paperclip.partnersinbiz.online/_plugins/e588ce00-a14b-49fc-b62d-54b0208daafa/ui/oauth-callback.html");
    expect(config.linkedinOrgPages).toBe(true);

    const app = await config.app("facebook");
    expect(app).toMatchObject({ clientId: "fb-id", clientSecret: "facebook-secret", apiVersion: "v22.0" });
    expect(resolve).toHaveBeenCalledWith(REF("fb"), { companyId: "co-1", configPath: "platforms.facebook.clientSecret" });

    await config.app("facebook");
    expect(resolve).toHaveBeenCalledTimes(1);

    const r2 = await config.r2();
    expect(r2).toMatchObject({ bucket: "media", secretAccessKey: "r2-secret", publicBaseUrl: "https://media.partnersinbiz.online" });
    expect(resolve).toHaveBeenLastCalledWith(REF("r2"), { companyId: "co-1", configPath: "r2.secretAccessKey" });
  });

  it("reports what is missing per platform", async () => {
    const { ctx } = ctxWith(FULL);
    const config = await loadSocialConfig(ctx, "co-1");
    expect(config.platform("facebook").configured).toBe(true);
    expect(config.platform("linkedin")).toMatchObject({ configured: false, missing: ["platforms.linkedin.clientSecret"] });
    expect(config.platform("x").missing).toEqual(["platforms.x.clientId", "platforms.x.clientSecret"]);
    expect(config.platform("bluesky").configured).toBe(true);
    await expect(config.app("linkedin")).rejects.toThrow(/LinkedIn is not configured/);
  });

  it("builds a keyring that seals tokens and fails closed without a key", async () => {
    const { ctx } = ctxWith(FULL);
    const keyring = await (await loadSocialConfig(ctx, "co-1")).keyring();
    expect(openJson<{ a: number }>(sealJson({ a: 1 }, keyring), keyring)).toEqual({ a: 1 });

    const { ctx: noKey } = ctxWith({ ...FULL, encryptionKey: undefined });
    await expect((await loadSocialConfig(noKey, "co-1")).keyring()).rejects.toBeInstanceOf(TokenKeyError);
  });

  it("opens tokens sealed with the previous key during rotation", async () => {
    const { ctx: oldCtx } = ctxWith({ ...FULL, encryptionKey: REF("prev") });
    const oldRing = await (await loadSocialConfig(oldCtx, "co-1")).keyring();
    const sealed = sealJson({ token: "t" }, oldRing);
    const { ctx } = ctxWith({ ...FULL, encryptionKeyVersion: 2, previousEncryptionKey: REF("prev"), previousEncryptionKeyVersion: 1 });
    const ring = await (await loadSocialConfig(ctx, "co-1")).keyring();
    expect(ring.currentVersion).toBe(2);
    expect(openJson<{ token: string }>(sealed, ring)).toEqual({ token: "t" });
  });

  it("requires a valid public base URL", async () => {
    const { ctx } = ctxWith({ ...FULL, publicBaseUrl: "" });
    const config = await loadSocialConfig(ctx, "co-1");
    expect(config.publicBaseUrl).toBeNull();
    expect(() => config.redirectUri()).toThrow(/Public base URL is not set/);
    const { ctx: http } = ctxWith({ ...FULL, publicBaseUrl: "http://paperclip.example.com" });
    expect((await loadSocialConfig(http, "co-1")).publicBaseUrlError).toMatch(/https/);
    const { ctx: local } = ctxWith({ ...FULL, publicBaseUrl: "http://localhost:3100" });
    expect((await loadSocialConfig(local, "co-1")).redirectUri()).toBe("http://localhost:3100/_plugins/e588ce00-a14b-49fc-b62d-54b0208daafa/ui/oauth-callback.html");
  });

  it("treats an unsaved config as not saved", async () => {
    const { ctx } = ctxWith({});
    const config = await loadSocialConfig(ctx, "co-1");
    expect(config.saved).toBe(false);
    expect(config.timezone).toBe("Africa/Johannesburg");
    expect(config.r2Configured).toBe(false);
  });
});
