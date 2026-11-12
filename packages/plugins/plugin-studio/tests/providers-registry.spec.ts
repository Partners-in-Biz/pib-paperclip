import { describe, expect, it } from "vitest";
import { LOOK_PACKS, providerOptions, providerStatus, resolveLookPack, resolveProvider, sttFor } from "../src/providers/registry.js";

const cfg = (def: Record<string, string | undefined>, key: string | null) =>
  ({
    providerDefault: async (c: "stt" | "tts") => def[c],
    hasSecret: async () => key !== null,
    xaiKey: async () => {
      if (!key) throw Object.assign(new Error('Voice needs an xAI key: set it under "xAI voice"'), { code: "not_configured" });
      return key;
    },
  }) as never;

describe("providers registry", () => {
  it("resolves override, then company default, then first", () => {
    expect(resolveProvider("stt").key).toBe("xai");
    expect(resolveProvider("tts", undefined, "xai").key).toBe("xai");
    expect(resolveProvider("stt", "xai", "nope").key).toBe("xai");
    expect(() => resolveProvider("stt", "nope", "xai")).toThrow(/Unknown provider/);
    expect(() => resolveProvider("tts", undefined, "nope")).toThrow(/Unknown provider/);
    try {
      resolveProvider("stt", "nope");
    } catch (e) {
      expect((e as { code?: string }).code).toBe("bad_request");
    }
  });

  it("reports status per capability without the key", async () => {
    expect(await providerStatus(cfg({}, "k"))).toEqual([
      { capability: "stt", provider: "xai", label: "xAI (Grok)", configured: true },
      { capability: "tts", provider: "xai", label: "xAI (Grok)", configured: true },
    ]);
    expect((await providerStatus(cfg({}, null))).every((p) => !p.configured)).toBe(true);
  });

  it("sttFor: bad provider and missing key fail; fake switch never needs a key", async () => {
    await expect(sttFor("nope", cfg({}, "k"))).rejects.toThrow(/Unknown provider/);
    await expect(sttFor(undefined, cfg({}, null))).rejects.toThrow(/xAI voice/);
    expect((await sttFor(undefined, cfg({}, "k"))).key).toBe("xai");
    process.env.PIB_STUDIO_FAKE_PROVIDER = "1";
    try {
      expect((await sttFor(undefined, cfg({}, null))).key).toBe("fake");
    } finally {
      delete process.env.PIB_STUDIO_FAKE_PROVIDER;
    }
  });

  it("looks kind: unknown pack refused, default resolves, options list it", async () => {
    expect(resolveLookPack().key).toBe("pib-basic");
    expect(resolveLookPack("pib-basic", "nope").key).toBe("pib-basic");
    expect(resolveLookPack(undefined, "pib-basic").ids).toHaveLength(12);
    expect(() => resolveLookPack("nope")).toThrow(/Unknown look pack/);
    expect(() => resolveLookPack(undefined, "nope")).toThrow(/Unknown look pack/);
    const opts = await providerOptions({ providerDefault: async (c: string) => (c === "looks" ? "pib-basic" : undefined) } as never);
    expect(opts.looks).toEqual(LOOK_PACKS.map((p) => ({ key: p.key, label: p.label, ids: p.ids, isDefault: p.key === "pib-basic" })));
    const broken = await providerOptions({ providerDefault: async (c: string) => (c === "looks" ? "nope" : undefined) } as never);
    expect(broken.looks.filter((p) => p.isDefault).map((p) => p.key)).toEqual(["pib-basic"]);
  });
});
