/** PAR-8134: Studio's brand kit view, the agent tool declaration, and the card's "Add brand kit to prompt" text. */
import { describe, it, expect, vi } from "vitest";
import { brandKitOf, type BrandKitResult } from "@partnersinbiz/pib-plugin-kit";
import { brandKitFor } from "../src/brand-kit.js";
import { STUDIO_TOOLS } from "../src/tools.js";
import { withBrandKit } from "../src/brand-kit-text.js";
import { MAX_TEXT } from "../src/canvas-rules.js";

const ctx = { events: { on: vi.fn(), emit: vi.fn() } } as any;
const acme = { scope: { kind: "company" as const, id: "acme" }, client: { kind: "company" as const, id: "acme", name: "Acme" } as any };
const kit = brandKitOf({ brandVoice: "Plain and warm", primaryColor: "#112233", bannedWords: ["cheap"], logoKey: "social/co/logo.png" });

describe("brandKitFor", () => {
  it("own work has no kit and asks the CRM nothing", async () => {
    const reader = vi.fn();
    const out = await brandKitFor(ctx, "co", { scope: null, client: null }, reader);
    expect(out).toMatchObject({ client: null, kit: null, promptText: "" });
    expect(reader).not.toHaveBeenCalled();
  });

  it("asks for exactly the resolved client and returns the text to add", async () => {
    const reader = vi.fn(async (): Promise<BrandKitResult> => ({ status: "read", requestId: "r1", client: { kind: "company", ref: "acme" }, kit, empty: false }));
    const out = await brandKitFor(ctx, "co", acme, reader);
    expect(reader).toHaveBeenCalledWith(ctx, expect.objectContaining({ companyId: "co", client: { kind: "company", ref: "acme" } }));
    expect(out.client).toBe("company:acme");
    expect(out.clientName).toBe("Acme");
    expect(out.promptText).toBe("Brand kit:\nBrand colours: primary #112233.\nBrand voice: Plain and warm\nNever use these words in any text: cheap.");
    expect(out.note).toContain("Nothing is added");
    expect(out.note).toContain("logo");
    expect(JSON.stringify(out)).not.toContain("logo.png");
  });

  it("a reply for another client is refused, never shown", async () => {
    const reader = vi.fn(async (): Promise<BrandKitResult> => ({ status: "failed", requestId: "r", reason: "wrong_client" }));
    await expect(brandKitFor(ctx, "co", acme, reader)).rejects.toMatchObject({ code: "wrong_client" });
  });

  it("no profile and no answer are plain messages", async () => {
    await expect(brandKitFor(ctx, "co", acme, async () => ({ status: "failed", requestId: "r", reason: "no_profile" }))).rejects.toMatchObject({ code: "no_brand_kit" });
    await expect(brandKitFor(ctx, "co", acme, async () => ({ status: "no_ack", requestId: "r" }))).rejects.toMatchObject({ code: "brand_kit_no_ack" });
  });

  it("an empty kit says so and has no text to add", async () => {
    const empty = brandKitOf({});
    const out = await brandKitFor(ctx, "co", acme, async () => ({ status: "read", requestId: "r", client: { kind: "company", ref: "acme" }, kit: empty, empty: true }));
    expect(out.promptText).toBe("");
    expect(out.note).toContain("empty");
  });
});

describe("studio-brand-kit tool", () => {
  it("is declared, free, and takes only client and issueId", () => {
    const tool = STUDIO_TOOLS.find((t) => t.name === "studio-brand-kit");
    expect(tool).toBeDefined();
    expect(Object.keys((tool!.parametersSchema as any).properties).sort()).toEqual(["client", "issueId"]);
    expect(new Set(STUDIO_TOOLS.map((t) => t.name)).size).toBe(STUDIO_TOOLS.length);
  });
});

describe("withBrandKit", () => {
  const text = "Brand kit:\nBrand voice: Plain";
  it("adds the kit once at the end of the card's prompt", () => {
    expect(withBrandKit("", text)).toBe(text);
    expect(withBrandKit("A red tractor ", text)).toBe(`A red tractor\n\n${text}`);
    expect(withBrandKit(`A red tractor\n\n${text}`, text)).toBe(`A red tractor\n\n${text}`);
  });
  it("refuses rather than cut the prompt when it would be too long", () => {
    expect(withBrandKit("x".repeat(MAX_TEXT - 5), text)).toBeNull();
  });
});
