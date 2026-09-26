import { describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { buildKeyring, open, openJson, seal, sealJson, sealedVersion, TokenKeyError } from "../src/crypto.js";
import { presignUrl, r2Upload, objectKeyFor } from "../src/r2.js";
import { skillVersion, syncManagedSkills, withFrontmatter } from "../src/skills.js";
import { SecretResolver } from "../src/config.js";
import { safeFetch } from "../src/safe-fetch.js";
import { oauthCallbackUrl, parsePluginUiBase, requirePublicBaseUrl } from "../src/index.js";
import { pluginUiBaseFromModule } from "../src/oauth-bridge/client.js";

describe("crypto", () => {
  const keyring = buildKeyring({ purpose: "social", companyId: "co-1", secret: "a-very-long-secret-value" });

  it("seals and opens", () => {
    const sealed = seal("hello", keyring);
    expect(sealed.startsWith("v1.")).toBe(true);
    expect(open(sealed, keyring)).toBe("hello");
    expect(openJson<{ a: number }>(sealJson({ a: 1 }, keyring), keyring)).toEqual({ a: 1 });
  });

  it("refuses short secrets", () => {
    expect(() => buildKeyring({ purpose: "social", companyId: "co-1", secret: "short" })).toThrow(TokenKeyError);
  });

  it("scopes keys to the company", () => {
    const other = buildKeyring({ purpose: "social", companyId: "co-2", secret: "a-very-long-secret-value" });
    expect(() => open(seal("x", keyring), other)).toThrow(TokenKeyError);
  });

  it("opens old versions after rotation", () => {
    const old = seal("legacy", keyring);
    const rotated = buildKeyring({
      purpose: "social",
      companyId: "co-1",
      secret: "the-new-secret-value-123",
      version: 2,
      previous: [{ version: 1, secret: "a-very-long-secret-value" }],
    });
    expect(open(old, rotated)).toBe("legacy");
    expect(sealedVersion(seal("new", rotated))).toBe(2);
  });
});

describe("SigV4 presign", () => {
  it("matches the AWS S3 query-auth example", () => {
    const url = presignUrl({
      method: "GET",
      host: "examplebucket.s3.amazonaws.com",
      path: "/test.txt",
      region: "us-east-1",
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      expiresSec: 86400,
      now: new Date("2013-05-24T00:00:00Z"),
    });
    expect(url).toContain("X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404");
    expect(url).toContain("X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request");
  });

  it("builds R2 upload and public URLs", () => {
    const key = objectKeyFor({ prefix: "social", companyId: "co-1", mime: "image/png", fileName: "Hero Shot.PNG" });
    expect(key).toMatch(/^social\/co-1\/\d{4}-\d{2}\/[0-9a-f-]+-hero-shot\.png$/);
    const out = r2Upload(
      { accountId: "acc", bucket: "media", accessKeyId: "AK", secretAccessKey: "SK", publicBaseUrl: "https://media.example.com/" },
      key,
    );
    expect(out.uploadUrl.startsWith(`https://acc.r2.cloudflarestorage.com/media/${key}?`)).toBe(true);
    expect(out.publicUrl).toBe(`https://media.example.com/${key}`);
  });

  it("rejects unknown media types", () => {
    expect(() => objectKeyFor({ prefix: "social", companyId: "c", mime: "text/html" })).toThrow();
  });
});

describe("skills", () => {
  it("hashes content and files deterministically", () => {
    const a = skillVersion({ skillKey: "k", markdown: "x", files: [{ path: "b", content: "2" }, { path: "a", content: "1" }] });
    const b = skillVersion({ skillKey: "k", markdown: "x", files: [{ path: "a", content: "1" }, { path: "b", content: "2" }] });
    const c = skillVersion({ skillKey: "k", markdown: "y" });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it("resets on a new version and reconciles when unchanged", async () => {
    const state = new Map<string, unknown>();
    const reset = vi.fn(async () => ({}));
    const reconcile = vi.fn(async () => ({}));
    const ctx = {
      state: {
        get: async (k: { stateKey: string; scopeId?: string }) => state.get(`${k.scopeId}:${k.stateKey}`) ?? null,
        set: async (k: { stateKey: string; scopeId?: string }, v: unknown) => void state.set(`${k.scopeId}:${k.stateKey}`, v),
      },
      skills: { managed: { reset, reconcile } },
    } as unknown as PluginContext;
    const skills = [{ skillKey: "seo", markdown: "one" }];
    expect((await syncManagedSkills(ctx, "co", skills))[0]!.action).toBe("reset");
    expect((await syncManagedSkills(ctx, "co", skills))[0]!.action).toBe("reconcile");
    expect((await syncManagedSkills(ctx, "co", [{ skillKey: "seo", markdown: "two" }]))[0]!.action).toBe("reset");
    expect(reset).toHaveBeenCalledTimes(2);
    expect(reconcile).toHaveBeenCalledTimes(1);
  });

  it("adds frontmatter", () => {
    const md = withFrontmatter({ name: "pib-seo-sprint", description: 'Run "the" sprint' }, "# Body");
    expect(md).toContain("name: pib-seo-sprint");
    expect(md).toContain("slug: pib-seo-sprint");
    expect(md).toContain("description: \"Run 'the' sprint\"");
    expect(md.endsWith("# Body")).toBe(true);
  });
});

describe("config", () => {
  it("resolves raw strings, secret refs and missing values", async () => {
    const resolve = vi.fn(async () => "resolved-secret");
    const ctx = { secrets: { resolve } } as unknown as PluginContext;
    const resolver = new SecretResolver(ctx, "co", {
      a: { raw: "plain" },
      b: { type: "secret_ref", secretId: "00000000-0000-0000-0000-000000000000" },
    });
    expect(await resolver.get("a.raw")).toBe("plain");
    expect(await resolver.get("b")).toBe("resolved-secret");
    expect(await resolver.get("b")).toBe("resolved-secret");
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith(expect.objectContaining({ type: "secret_ref" }), { companyId: "co", configPath: "b" });
    expect(await resolver.get("missing.path")).toBeUndefined();
    await expect(resolver.require("missing.path", "Thing")).rejects.toThrow("Thing is not set");
  });
});

describe("safeFetch", () => {
  it("follows redirects through the host fetch", async () => {
    const calls: string[] = [];
    const ctx = {
      http: {
        fetch: async (url: string) => {
          calls.push(url);
          if (url === "https://example.com/") return new Response(null, { status: 301, headers: { location: "/home" } });
          return new Response("<html>ok</html>", { status: 200, headers: { "content-type": "text/html" } });
        },
      },
    } as unknown as PluginContext;
    const res = await safeFetch(ctx, "example.com");
    expect(calls).toEqual(["https://example.com/", "https://example.com/home"]);
    expect(res.status).toBe(200);
    expect(res.url).toBe("https://example.com/home");
    expect(res.redirects).toEqual(["https://example.com/"]);
    expect(res.text).toContain("ok");
  });
});

describe("urls", () => {
  it("builds the callback URL and validates the base", () => {
    const uuid = "051bbf0b-aeb5-42d7-b0b6-c4cabd271cdc";
    expect(oauthCallbackUrl("https://p.example.com/", `/_plugins/${uuid}/ui/`)).toBe(
      `https://p.example.com/_plugins/${uuid}/ui/oauth-callback.html`,
    );
    expect(() => oauthCallbackUrl("https://p.example.com", "/_plugins/partnersinbiz.social/ui/")).toThrow();
    expect(pluginUiBaseFromModule(`http://127.0.0.1:3100/_plugins/${uuid.toUpperCase()}/ui/index.js?v=3`)).toBe(`/_plugins/${uuid}/ui/`);
    expect(pluginUiBaseFromModule("http://127.0.0.1:3100/_plugins/partnersinbiz.seo/ui/index.js")).toBeNull();
    expect(parsePluginUiBase(`/_plugins/${uuid}/ui/`)).toBe(`/_plugins/${uuid}/ui/`);
    expect(parsePluginUiBase("/_plugins/../ui/")).toBeNull();
    expect(requirePublicBaseUrl("http://localhost:3100/")).toBe("http://localhost:3100");
    expect(() => requirePublicBaseUrl("http://example.com")).toThrow();
    expect(() => requirePublicBaseUrl("")).toThrow();
  });
});
