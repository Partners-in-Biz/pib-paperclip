import { describe, expect, it } from "vitest";
import { LOOK_PACKS, musicFor, providerOptions, providerStatus, resolveLookPack, resolveProvider, sttFor } from "../src/providers/registry.js";

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
      { capability: "music", provider: "stability", label: "Stability AI (Stable Audio)", configured: true },
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

describe("music capability (PAR-10255)", () => {
  it("lists music/stability in status and options without a key", async () => {
    const status = await providerStatus(cfg({}, "secret-key"));
    expect(status.find((p) => p.capability === "music")).toEqual({ capability: "music", provider: "stability", label: "Stability AI (Stable Audio)", configured: true });
    expect(JSON.stringify(status)).not.toContain("secret-key");
    const options = await providerOptions({ providerDefault: async () => undefined });
    expect(options.music).toEqual([
      expect.objectContaining({ key: "stability", isDefault: true, price: "USD 0.08 (1.28 credits) per track, up to 180 s", qualityNote: "Stable Audio 2.5, instrumental music and sound beds" }),
    ]);
  });
  it("resolveProvider only accepts stability", () => {
    expect(resolveProvider("music").key).toBe("stability");
    expect(resolveProvider("music", "stability").key).toBe("stability");
    try {
      resolveProvider("music", "nope");
      expect.unreachable();
    } catch (e) {
      expect((e as { code?: string }).code).toBe("bad_request");
    }
  });
  it("musicFor: missing key fails; the fake switch needs none", async () => {
    const config = { stabilityKey: async () => { throw Object.assign(new Error("Music needs a Stability AI key"), { code: "not_configured" }); } } as never;
    const prev = process.env.PIB_STUDIO_FAKE_PROVIDER;
    delete process.env.PIB_STUDIO_FAKE_PROVIDER;
    await expect(musicFor(config)).rejects.toThrow(/Stability AI key/);
    await expect(musicFor(config, "nope")).rejects.toThrow(/Unknown provider/);
    process.env.PIB_STUDIO_FAKE_PROVIDER = "1";
    expect((await musicFor(config)).key).toBe("fake");
    if (prev === undefined) delete process.env.PIB_STUDIO_FAKE_PROVIDER;
    else process.env.PIB_STUDIO_FAKE_PROVIDER = prev;
  });
});
