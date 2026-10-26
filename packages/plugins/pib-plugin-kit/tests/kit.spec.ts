import { describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { buildKeyring, open, openJson, seal, sealJson, sealedVersion, TokenKeyError } from "../src/crypto.js";
import { presignUrl, r2Upload, objectKeyFor } from "../src/r2.js";
import { skillVersion, syncManagedSkills, withFrontmatter } from "../src/skills.js";
import { SecretResolver } from "../src/config.js";
import { safeFetch, safeFetchBytes } from "../src/safe-fetch.js";
import { oauthCallbackUrl, parsePluginUiBase, requirePublicBaseUrl } from "../src/index.js";
import { pluginUiBaseFromModule } from "../src/oauth-bridge/client.js";
import { getCrmCompany, registerCrmProjection, type CrmCompanyBilling } from "../src/crm-projection.js";

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

  it("resets a skill whose company copy drifted even when its version is marked deployed", async () => {
    const state = new Map<string, unknown>();
    const reset = vi.fn(async () => ({}));
    let drift: { changedFiles: string[] } | null = { changedFiles: ["SKILL.md"] };
    const reconcile = vi.fn(async () => ({ defaultDrift: drift }));
    const ctx = {
      state: {
        get: async (k: { stateKey: string; scopeId?: string }) => state.get(`${k.scopeId}:${k.stateKey}`) ?? null,
        set: async (k: { stateKey: string; scopeId?: string }, v: unknown) => void state.set(`${k.scopeId}:${k.stateKey}`, v),
      },
      skills: { managed: { reset, reconcile } },
    } as unknown as PluginContext;
    const skills = [{ skillKey: "operator", markdown: "new" }];
    // An interrupted upgrade marked the new version as deployed, but the company still has the old copy.
    state.set(`co:${"x"}`, null);
    await syncManagedSkills(ctx, "co", skills); // first run: marks the version
    expect((await syncManagedSkills(ctx, "co", skills))[0]!.action).toBe("reset");
    drift = null;
    expect((await syncManagedSkills(ctx, "co", skills))[0]!.action).toBe("reconcile");
  });

  it("adds frontmatter", () => {
    const md = withFrontmatter({ name: "pib-seo-sprint", description: 'Run "the" sprint' }, "# Body");
    expect(md).toContain("name: pib-seo-sprint");
    expect(md).toContain("slug: pib-seo-sprint");
    expect(md).toContain("description: \"Run 'the' sprint\"");
    expect(md).toContain("---\n\n# Body");
    expect(md).toContain("## Company memory");
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

describe("safeFetchBytes", () => {
  it("returns binary bytes intact", async () => {
    const binaryData = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); // PNG signature
    const ctx = {
      http: {
        fetch: async () => new Response(binaryData.buffer, { status: 200, headers: { "content-type": "image/png" } }),
      },
    } as unknown as PluginContext;
    const res = await safeFetchBytes(ctx, "https://example.com/image.png");
    expect(res.status).toBe(200);
    expect(res.url).toBe("https://example.com/image.png");
    expect(res.contentType).toBe("image/png");
    expect(res.bytes).toEqual(binaryData);
  });

  it("follows redirects and re-checks each hop", async () => {
    const calls: string[] = [];
    const binaryData = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]); // JPEG signature
    const ctx = {
      http: {
        fetch: async (url: string) => {
          calls.push(url);
          if (url === "https://example.com/") return new Response(null, { status: 301, headers: { location: "/final" } });
          if (url === "https://example.com/final") return new Response(null, { status: 301, headers: { location: "https://blocked.local/" } });
          // This should fail because blocked.local would be rejected by ctx.http.fetch (SSRF guard)
          throw new Error("SSRF protection: blocked");
        },
      },
    } as unknown as PluginContext;
    await expect(safeFetchBytes(ctx, "example.com")).rejects.toThrow("SSRF protection");
    expect(calls).toContain("https://example.com/");
    expect(calls).toContain("https://example.com/final");
  });

  it("rejects when maxRedirects exceeded", async () => {
    const ctx = {
      http: {
        fetch: async (url: string) => {
          const count = parseInt(url.split("/").pop() || "0", 10);
          if (count < 10) return new Response(null, { status: 301, headers: { location: `https://example.com/${count + 1}` } });
          return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
        },
      },
    } as unknown as PluginContext;
    await expect(safeFetchBytes(ctx, "https://example.com/0", { maxRedirects: 3 })).rejects.toThrow("Too many redirects");
  });

  it("rejects early when Content-Length exceeds maxBytes", async () => {
    const ctx = {
      http: {
        fetch: async () =>
          new Response(null, { status: 200, headers: { "content-length": "100000000" } }),
      },
    } as unknown as PluginContext;
    await expect(safeFetchBytes(ctx, "https://example.com/large", { maxBytes: 1000 })).rejects.toThrow(
      "Response exceeds maxBytes limit"
    );
  });

  it("rejects when streamed response exceeds maxBytes", async () => {
    const ctx = {
      http: {
        fetch: async () => {
          const chunks = [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6])];
          let index = 0;
          const readable = new ReadableStream<Uint8Array>({
            pull(controller) {
              if (index < chunks.length) {
                controller.enqueue(chunks[index++]);
              } else {
                controller.close();
              }
            },
          });
          return new Response(readable, { status: 200 });
        },
      },
    } as unknown as PluginContext;
    await expect(safeFetchBytes(ctx, "https://example.com/stream", { maxBytes: 5 })).rejects.toThrow(
      "Response exceeds maxBytes limit"
    );
  });

  it("rejects when arrayBuffer exceeds maxBytes", async () => {
    const largeData = new Uint8Array(10000);
    const ctx = {
      http: {
        fetch: async () =>
          new Response(largeData.buffer, { status: 200 }),
      },
    } as unknown as PluginContext;
    await expect(safeFetchBytes(ctx, "https://example.com/large", { maxBytes: 1000 })).rejects.toThrow(
      "Response exceeds maxBytes limit"
    );
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

describe("CRM company projection billing option", () => {
  const billing: CrmCompanyBilling = {
    email: "accounts@acme.test",
    phone: "+27 21 000 0000",
    address: "1 Long St, Cape Town",
    vatNumber: "4123456789",
    registrationNumber: "2020/123456/07",
  };
  const event = { id: "c1", name: "Acme", domain: "acme.test", lifecycle: "customer", updatedAt: "2026-10-06T00:00:00Z" };

  function harness(options?: Parameters<typeof registerCrmProjection>[2], queryRows: unknown[] = []) {
    const handlers = new Map<string, (e: unknown) => Promise<void>>();
    const execute = vi.fn(async (..._args: unknown[]) => ({ rowCount: 1 }));
    const query = vi.fn(async (..._args: unknown[]) => queryRows);
    const ctx = {
      events: { on: (name: string, fn: (e: unknown) => Promise<void>) => void handlers.set(name, fn) },
      db: { execute, query },
      logger: { info: vi.fn() },
    } as unknown as PluginContext;
    if (options) registerCrmProjection(ctx, "plugin_x", options);
    else registerCrmProjection(ctx, "plugin_x");
    const emit = (payload: Record<string, unknown>) =>
      handlers.get("plugin.partnersinbiz.crm.company.upserted")!({ companyId: "co-1", payload });
    return { ctx, execute, query, emit };
  }

  it("keeps today's SQL and six parameters when the option is off", async () => {
    for (const options of [undefined, { companyBilling: false }]) {
      const { execute, emit } = harness(options);
      await emit({ ...event, billing });
      const [sql, params] = execute.mock.calls[0] as [string, unknown[]];
      expect(params).toHaveLength(6);
      expect(sql).not.toContain("billing");
    }
  });

  it("writes billing as the seventh parameter when the option is on", async () => {
    const { execute, emit } = harness({ companyBilling: true });
    await emit({ ...event, billing });
    const [sql, params] = execute.mock.calls[0] as [string, unknown[]];
    expect(params).toHaveLength(7);
    expect(params[6]).toBe(JSON.stringify(billing));
    expect(sql).toContain("$7::jsonb");
    expect(sql).toContain("billing = EXCLUDED.billing");
  });

  it("writes JSON null when the event has no billing key", async () => {
    const { execute, emit } = harness({ companyBilling: true });
    await emit(event);
    const [, params] = execute.mock.calls[0] as [string, unknown[]];
    expect(params).toHaveLength(7);
    expect(params[6]).toBe("null");
  });

  it("writes hosted as the seventh parameter when only companyHosted is on", async () => {
    const hosted = { companyId: "hosted-1", plan: "growth" };
    const { execute, emit } = harness({ companyHosted: true });
    await emit({ ...event, billing, hosted });
    const [sql, params] = execute.mock.calls[0] as [string, unknown[]];
    expect(params).toHaveLength(7);
    expect(params[6]).toBe(JSON.stringify(hosted));
    expect(sql).toContain("$7::jsonb");
    expect(sql).toContain("hosted = EXCLUDED.hosted");
    expect(sql).not.toContain("billing");
  });

  it("writes billing then hosted when both options are on, JSON null for a missing hosted key", async () => {
    const { execute, emit } = harness({ companyBilling: true, companyHosted: true });
    await emit({ ...event, billing });
    const [sql, params] = execute.mock.calls[0] as [string, unknown[]];
    expect(params).toHaveLength(8);
    expect(params[6]).toBe(JSON.stringify(billing));
    expect(params[7]).toBe("null");
    expect(sql).toContain("billing = EXCLUDED.billing");
    expect(sql).toContain("hosted = EXCLUDED.hosted");
  });

  it("reads billing only when asked", async () => {
    const row = { id: "c1", name: "Acme", domain: null, lifecycle: null, billing };
    const { ctx, query } = harness(undefined, [row]);
    expect(await getCrmCompany(ctx, "plugin_x", "co-1", "c1")).toEqual(row);
    expect(query.mock.calls[0]![0]).not.toContain("billing");
    const withBilling = await getCrmCompany(ctx, "plugin_x", "co-1", "c1", { billing: true });
    expect(query.mock.calls[1]![0]).toContain("billing");
    expect(withBilling?.billing).toEqual(billing);
  });
});
