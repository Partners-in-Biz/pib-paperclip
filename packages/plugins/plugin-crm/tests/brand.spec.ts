import { describe, expect, it } from "vitest";
import { colorField, logoKeyField, missingBrandFields, missingProposalFields, pickProfile, profileOwnership, profilePatch, refField } from "../src/lookup.js";
import { BRAND_FIELDS, CORE_PROFILE_FIELDS, EMPTY_PROFILE, PROFILE_FIELDS, PROPOSAL_FIELDS } from "../src/store.js";
import { BOARD, CO, boot, tool, toolRaw } from "./helpers/crm.js";

const LOGO = `social/${CO}/acme/logo.png`;
const BRAND = { primaryColor: "#0a7a3d", secondaryColor: "fff", accentColor: "#FFB400", fonts: ["Playfair Display", "Inter"], toneExamples: ["Hi there, your plumber is on the way.", "No fuss, no jargon, no surprises."], logoKey: LOGO };

describe("the brand kit and proposal fields on the client profile", () => {
  it("fills them from a tool, keeps colours as #RRGGBB in capitals, and reads them back", async () => {
    const { harness, store } = await boot();
    const result = await tool<Record<string, any>>(harness, "update-client-profile", { client: "company:acme", ...BRAND, scopeTemplateRef: "billing:template:scope-v2", termsRef: "docs/terms-2026.md" });
    expect(result.changed).toEqual(["logoKey", "primaryColor", "secondaryColor", "accentColor", "fonts", "toneExamples", "scopeTemplateRef", "termsRef"].sort((a, b) => PROFILE_FIELDS.indexOf(a as never) - PROFILE_FIELDS.indexOf(b as never)));
    expect(result.profile).toMatchObject({ logoKey: LOGO, primaryColor: "#0A7A3D", secondaryColor: "#FFFFFF", accentColor: "#FFB400", fonts: ["Playfair Display", "Inter"], toneExamples: BRAND.toneExamples, scopeTemplateRef: "billing:template:scope-v2", termsRef: "docs/terms-2026.md", missingBrand: [], missingProposal: [] });
    const read = await tool<Record<string, any>>(harness, "get-client-profile", { client: "company:acme" });
    expect(read.profile).toMatchObject({ logoKey: LOGO, primaryColor: "#0A7A3D", fonts: ["Playfair Display", "Inter"] });
    expect(read.brandKitNext).toBeUndefined();
    // Saved in its own columns, lists as JSON.
    expect(store.client_profiles[0]).toMatchObject({ logo_key: LOGO, primary_color: "#0A7A3D", secondary_color: "#FFFFFF", accent_color: "#FFB400", fonts: ["Playfair Display", "Inter"], tone_examples: BRAND.toneExamples, scope_template_ref: "billing:template:scope-v2", terms_ref: "docs/terms-2026.md" });
  });

  it("says what the brand kit still needs, apart from the seven core fields", async () => {
    const { harness } = await boot();
    const empty = await tool<Record<string, any>>(harness, "get-client-profile", { client: "company:acme" });
    expect(empty.profile.missing).toEqual(["brandVoice", "audience", "services", "website", "bookingLink", "bannedWords", "toneNotes"]);
    expect(empty.profile.missingBrand).toEqual(["logoKey", "primaryColor", "fonts", "toneExamples"]);
    expect(empty.profile.missingProposal).toEqual(["scopeTemplateRef", "termsRef"]);
    expect(empty.brandKitNext).toMatch(/Brand kit still missing: logoKey, primaryColor, fonts, toneExamples/);
    await tool(harness, "update-client-profile", { client: "company:acme", primaryColor: "#123456", fonts: ["Inter"] });
    const part = await tool<Record<string, any>>(harness, "get-client-profile", { client: "company:acme" });
    expect(part.profile.missingBrand).toEqual(["logoKey", "toneExamples"]);
    // The core list is unchanged by the brand fields: a profile with the seven core fields is still "complete" there.
    expect(part.profile.missing).toHaveLength(7);
    expect(CORE_PROFILE_FIELDS).toHaveLength(7);
    expect(BRAND_FIELDS).toEqual(["logoKey", "primaryColor", "secondaryColor", "accentColor", "fonts", "toneExamples"]);
    expect(PROPOSAL_FIELDS).toEqual(["scopeTemplateRef", "termsRef"]);
    expect(missingBrandFields(EMPTY_PROFILE)).toHaveLength(4);
    expect(missingProposalFields(EMPTY_PROFILE)).toHaveLength(2);
  });

  it("clears a field with null or an empty value, and leaves the rest alone", async () => {
    const { harness } = await boot();
    await tool(harness, "update-client-profile", { client: "company:acme", ...BRAND });
    const cleared = await tool<Record<string, any>>(harness, "update-client-profile", { client: "company:acme", primaryColor: null, fonts: [], toneExamples: "", logoKey: "" });
    expect(cleared.changed).toEqual(["logoKey", "primaryColor", "fonts", "toneExamples"]);
    expect(cleared.profile).toMatchObject({ primaryColor: null, fonts: [], toneExamples: [], logoKey: null, secondaryColor: "#FFFFFF", accentColor: "#FFB400" });
  });

  it("refuses a colour that is not a hex colour, with the example", async () => {
    const { harness } = await boot();
    for (const bad of ["red", "#12", "#12345", "#GGGGGG", "rgb(1,2,3)", "0a7a3d0"]) {
      expect((await toolRaw(harness, "update-client-profile", { client: "company:acme", primaryColor: bad })).error, bad).toMatch(/primaryColor must be a hex colour such as #1A73E8/);
    }
    expect(colorField("#abc", "c")).toBe("#AABBCC");
    expect(colorField("  0A7A3D ", "c")).toBe("#0A7A3D");
    expect(colorField(null, "c")).toBeNull();
  });

  it("takes a logo key only from this company's folder in the bucket", async () => {
    const { harness } = await boot();
    for (const bad of [`social/co-2/logo.png`, `/social/${CO}/logo.png`, `social/${CO}/../co-2/logo.png`, `social/${CO}//logo.png`, "logo.png", `https://cdn.example/${CO}/logo.png`, `social/${CO}/`, `Social/${CO}/a.png`]) {
      expect((await toolRaw(harness, "update-client-profile", { client: "company:acme", logoKey: bad })).error, bad).toMatch(/logoKey must be an R2 object key inside this company's folder, such as social\/co-1\/logo\.png/);
    }
    expect(logoKeyField(`brand/${CO}/acme/logo-dark.svg`, CO)).toBe(`brand/${CO}/acme/logo-dark.svg`);
    // Without a company to check against, only the shape is checked.
    expect(logoKeyField("social/co-9/logo.png", undefined)).toBe("social/co-9/logo.png");
    expect(() => logoKeyField("social/co-9/logo.png", CO)).toThrow(/inside this company's folder/);
  });

  it("limits fonts, tone examples and references", async () => {
    const { harness } = await boot();
    expect((await toolRaw(harness, "update-client-profile", { client: "company:acme", fonts: ["Inter; DROP TABLE"] })).error).toMatch(/Not a font name/);
    expect((await toolRaw(harness, "update-client-profile", { client: "company:acme", fonts: ["A", "B", "C", "D", "E", "F", "G"] })).error).toMatch(/fonts has too many items \(6 at most\)/);
    expect((await toolRaw(harness, "update-client-profile", { client: "company:acme", toneExamples: Array.from({ length: 9 }, (_, i) => `Example ${i}`) })).error).toMatch(/toneExamples has too many items \(8 at most\)/);
    expect((await toolRaw(harness, "update-client-profile", { client: "company:acme", toneExamples: ["x".repeat(401)] })).error).toMatch(/400 characters at most/);
    expect((await toolRaw(harness, "update-client-profile", { client: "company:acme", toneExamples: [1] })).error).toMatch(/list of text/);
    expect((await toolRaw(harness, "update-client-profile", { client: "company:acme", termsRef: "terms with spaces.pdf" })).error).toMatch(/termsRef must be a document id, path or link \(no spaces\)/);
    expect(refField("https://acme.co.za/terms?v=2#top", "r")).toBe("https://acme.co.za/terms?v=2#top");
    expect(() => refField("x".repeat(301), "r")).toThrow(/300 characters at most/);
    expect(refField("", "r")).toBeNull();
  });

  it("keeps a tone example whole even when it has commas, and takes a text field as lines", () => {
    expect(profilePatch({ toneExamples: ["Hi there, friend, how can we help?"] }).toneExamples).toEqual(["Hi there, friend, how can we help?"]);
    expect(profilePatch({ toneExamples: "First line, with comma\nSecond line" }).toneExamples).toEqual(["First line, with comma", "Second line"]);
    expect(profilePatch({ fonts: "Inter, Lora" }).fonts).toEqual(["Inter", "Lora"]);
  });

  it("a person's colour is theirs: an agent may fill an empty brand field but never replace a locked one", async () => {
    const { harness } = await boot();
    await harness.performAction("crm.update-client-profile", { client: "company:acme", primaryColor: "#112233", fonts: ["Lora"] }, { companyId: CO, actor: BOARD });
    const attempt = await toolRaw(harness, "update-client-profile", { client: "company:acme", primaryColor: "#FF0000", accentColor: "#00FF00" });
    expect(attempt.error).toMatch(/Refused to overwrite human-owned fields: primaryColor/);
    expect(attempt.data!.changed).toEqual(["accentColor"]);
    const read = await tool<Record<string, any>>(harness, "get-client-profile", { client: "company:acme" });
    expect(read.profile).toMatchObject({ primaryColor: "#112233", accentColor: "#00FF00" });
    expect(read.humanOwned).toEqual(["fonts", "primaryColor"].sort((a, b) => PROFILE_FIELDS.indexOf(a as never) - PROFILE_FIELDS.indexOf(b as never)));
  });

  it("lets a person lock the new fields, and refuses a name that is not a profile field", () => {
    expect(profileOwnership(["logoKey", "termsRef", "primaryColor"])).toEqual(["primaryColor", "logoKey", "termsRef"].sort((a, b) => PROFILE_FIELDS.indexOf(a as never) - PROFILE_FIELDS.indexOf(b as never)));
    expect(() => profileOwnership(["servicesOther"])).toThrow(/Not profile fields: servicesOther/);
  });

  it("shows the brand kit on the client page", async () => {
    const { harness } = await boot();
    await tool(harness, "update-client-profile", { client: "company:acme", ...BRAND });
    const ws = await harness.performAction<Record<string, any>>("crm.client-workspace", { client: "company:acme" }, { companyId: CO, actor: BOARD });
    expect(ws.profile).toMatchObject({ primaryColor: "#0A7A3D", logoKey: LOGO, fonts: ["Playfair Display", "Inter"], servicesOther: [] });
  });

  it("reads a profile row written before these columns existed", async () => {
    const { harness, store } = await boot();
    store.client_profiles = [{ id: "pr1", company_id: CO, client_kind: "company", client_ref: "acme", brand_voice: "Warm", audience: null, services: [], website: null, booking_link: null, banned_words: [], tone_notes: null, human_owned: [], updated_by: null, updated_at: "2026-09-20T00:00:00Z" }];
    const read = await tool<Record<string, any>>(harness, "get-client-profile", { client: "company:acme" });
    expect(read.profile).toMatchObject({ brandVoice: "Warm", logoKey: null, fonts: [], toneExamples: [], servicesOther: [], missingBrand: ["logoKey", "primaryColor", "fonts", "toneExamples"] });
    expect(pickProfile({ ...EMPTY_PROFILE, brandVoice: "x" }).primaryColor).toBeNull();
  });
});
