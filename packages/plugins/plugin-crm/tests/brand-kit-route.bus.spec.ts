/**
 * PAR-8134: the brand kit route over the host's REAL plugin event bus (server/src/services/plugin-event-bus.ts), with
 * Studio's kit `requestBrandKit` and the CRM both subscribed. Only the profile read is stubbed (it needs Postgres);
 * event names, the producer allowlist, and company and client scoping run for real.
 */
import { describe, it, expect, vi } from "vitest";
import { brandKitPrompt, requestBrandKit } from "@partnersinbiz/pib-plugin-kit";
import { registerBrandKitRoute } from "../src/brand-kit-route.js";

interface ScopedBus {
  subscribe(pattern: string, fn: (event: any) => Promise<void> | void): void;
  emit(name: string, companyId: string, payload: unknown): Promise<{ errors: unknown[] }>;
}
interface HostBus {
  forPlugin(pluginId: string): ScopedBus;
}

const BUS_MODULE = new URL("../../../../server/src/services/plugin-event-bus.ts", import.meta.url).href;
async function hostBus(): Promise<HostBus> {
  const mod = (await import(/* @vite-ignore */ BUS_MODULE)) as { createPluginEventBus: () => HostBus };
  return mod.createPluginEventBus();
}

function pluginCtx(bus: HostBus, pluginId: string) {
  const scoped = bus.forPlugin(pluginId);
  return {
    events: {
      on: (name: string, ...rest: unknown[]) => {
        scoped.subscribe(name, rest[rest.length - 1] as (event: any) => Promise<void>);
        return () => undefined;
      },
      emit: async (name: string, companyId: string, payload: unknown) => {
        await scoped.emit(name, companyId, payload);
      },
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  } as any;
}

// company-a has clients co-a (full kit, with a logo) and co-b (voice only); company-b has none.
const PROFILES: Record<string, Record<string, unknown>> = {
  "company-a/company/co-a": {
    brandVoice: "Warm and plain",
    audience: "Farmers",
    toneNotes: null,
    bannedWords: ["cheap"],
    primaryColor: "#2962AE",
    secondaryColor: "#639950",
    accentColor: "not-a-colour",
    fonts: ["Inter"],
    toneExamples: [],
    logoKey: "social/company-a/logo.png",
    website: "https://example.test",
  },
  "company-a/company/co-b": { brandVoice: "Sober and calm", bannedWords: [], fonts: [], toneExamples: [] },
};

async function setup() {
  const bus = await hostBus();
  const readProfile = vi.fn(async (_ctx: unknown, companyId: string, kind: string, ref: string) => PROFILES[`${companyId}/${kind}/${ref}`] ?? null);
  registerBrandKitRoute(pluginCtx(bus, "partnersinbiz.crm"), readProfile as any);
  return { bus, readProfile, studio: pluginCtx(bus, "partnersinbiz.studio") };
}

describe("brand kit route on the host event bus (PAR-8134)", () => {
  it("Studio gets its client's kit, only brand fields, and never the logo key", async () => {
    const { studio, readProfile } = await setup();
    const out = await requestBrandKit(studio, { companyId: "company-a", client: { kind: "company", ref: "co-a" }, timeoutMs: 2_000 });
    expect(out.status).toBe("read");
    if (out.status !== "read") return;
    expect(readProfile).toHaveBeenCalledWith(expect.anything(), "company-a", "company", "co-a");
    expect(out.client).toEqual({ kind: "company", ref: "co-a" });
    expect(out.kit).toEqual({
      brandVoice: "Warm and plain",
      audience: "Farmers",
      toneNotes: null,
      bannedWords: ["cheap"],
      primaryColor: "#2962AE",
      secondaryColor: "#639950",
      accentColor: null,
      fonts: ["Inter"],
      toneExamples: [],
      hasLogo: true,
    });
    expect(JSON.stringify(out)).not.toContain("logo.png");
    expect(JSON.stringify(out)).not.toContain("example.test");
    expect(brandKitPrompt(out.kit)).toContain("Brand colours: primary #2962AE, secondary #639950.");
    expect(brandKitPrompt(out.kit)).toContain("Never use these words in any text: cheap.");
  });

  it("two clients asked at once each get their own kit", async () => {
    const { studio } = await setup();
    const [a, b] = await Promise.all([
      requestBrandKit(studio, { companyId: "company-a", client: { kind: "company", ref: "co-a" }, timeoutMs: 2_000 }),
      requestBrandKit(studio, { companyId: "company-a", client: { kind: "company", ref: "co-b" }, timeoutMs: 2_000 }),
    ]);
    expect(a.status === "read" && a.kit.brandVoice).toBe("Warm and plain");
    expect(b.status === "read" && b.kit.brandVoice).toBe("Sober and calm");
    expect(b.status === "read" && b.kit.primaryColor).toBeNull();
  });

  it("another company asking for co-a reads its own profiles only and gets no kit", async () => {
    const { studio, readProfile } = await setup();
    const out = await requestBrandKit(studio, { companyId: "company-b", client: { kind: "company", ref: "co-a" }, timeoutMs: 2_000 });
    expect(out).toMatchObject({ status: "failed", reason: "no_profile" });
    expect(readProfile).toHaveBeenCalledWith(expect.anything(), "company-b", "company", "co-a");
  });

  it("a plugin not on the brand kit list gets no answer", async () => {
    const { bus, readProfile } = await setup();
    const social = pluginCtx(bus, "partnersinbiz.social");
    const out = await requestBrandKit(social, { companyId: "company-a", client: { kind: "company", ref: "co-a" }, timeoutMs: 300 });
    expect(out.status).toBe("no_ack");
    expect(readProfile).not.toHaveBeenCalled();
  });

  it("a bad client is refused before anything is sent", async () => {
    const { studio, readProfile } = await setup();
    const out = await requestBrandKit(studio, { companyId: "company-a", client: { kind: "own", ref: "x" }, timeoutMs: 300 });
    expect(out).toMatchObject({ status: "failed", reason: "invalid_input" });
    expect(readProfile).not.toHaveBeenCalled();
  });
});
