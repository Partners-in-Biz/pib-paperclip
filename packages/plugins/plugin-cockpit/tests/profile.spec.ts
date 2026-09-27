/**
 * The company profile: owners edit it on Cockpit → Profile; agents read it
 * and may only fill empty fields.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { applyEdit, cleanField, fillEmpty, missingFields, normalizeUrl, parseProfile, parseWordList, PROFILE_FIELDS, ProfileError } from "../src/profile-model.js";
import { ownSetupStatus } from "../src/own.js";
import { createEnv, registerCockpit } from "../src/register.js";
import { agentNote, draftErrors, draftFrom, ProfileForm } from "../src/ui/profile.js";
import { fakeCtx, fixedClock } from "./helpers/fake-ctx.js";

const A = "company-a";
const RUN = { agentId: "op", runId: "r1", companyId: A, projectId: "p1" };
const user = { companyId: A, actor: { type: "user", userId: "user-1" } };

function setup() {
  const fake = fakeCtx({ savedConfigs: { [A]: { healthIssue: true } }, prefixes: { [A]: "PIB" }, agents: [{ id: "op", companyId: A, name: "Olive", status: "active" }] });
  const env = createEnv(fake.ctx, fixedClock("2026-09-26T10:00:00.000Z").now);
  registerCockpit(fake.ctx, env);
  const tool = (name: string, params: Record<string, unknown>) => fake.tools.get(name)!(params, RUN) as Promise<{ content: string; data: Record<string, any>; error?: string }>;
  return { ...fake, env, tool };
}

describe("profile fields", () => {
  it("cleans and checks each kind of field", () => {
    expect(cleanField("website", "example.co.za")).toBe("https://example.co.za");
    expect(cleanField("bookingLink", "https://cal.com/peet/30min")).toBe("https://cal.com/peet/30min");
    expect(() => cleanField("website", "not a site")).toThrow(ProfileError);
    expect(() => cleanField("website", "ftp://x.co.za")).toThrow(/web address/);
    expect(cleanField("senderEmail", " Hello@Example.co.za ")).toBe("hello@example.co.za");
    expect(() => cleanField("senderEmail", "hello")).toThrow(/email address/);
    expect(cleanField("vatNumber", "4123 456 789")).toBe("4123456789");
    expect(() => cleanField("vatNumber", "123")).toThrow(/10 digits and starts with 4/);
    expect(cleanField("legalName", "  Partners   in Biz (Pty) Ltd ")).toBe("Partners in Biz (Pty) Ltd");
    expect(cleanField("legalName", "   ")).toBeUndefined();
    expect(() => cleanField("brandVoice", "x".repeat(1001))).toThrow(/at most 1000/);
    expect(cleanField("bannedWords", "cheap, Cheap\nworld-class;  guaranteed ")).toEqual(["cheap", "world-class", "guaranteed"]);
    expect(parseWordList(["a", 2, "a"])).toEqual(["a"]);
    expect(normalizeUrl("localhost")).toBeNull();
    expect(parseProfile({ legalName: "X", junk: "y", bannedWords: "a,b" })).toEqual({ legalName: "X", bannedWords: ["a", "b"] });
  });

  it("agents fill empty fields only; set values are kept for the owner to change", () => {
    const current = { legalName: "Partners in Biz (Pty) Ltd", bannedWords: ["cheap"] };
    const result = fillEmpty(current, { legalName: "PiB Ltd", website: "partnersinbiz.online", bannedWords: ["Cheap"], senderEmail: "nope", mystery: "x", issueId: "PIB-1" });
    expect(result.filled).toEqual(["website"]);
    expect(result.unchanged).toEqual(["bannedWords"]);
    expect(result.kept).toEqual([{ field: "legalName", current: "Partners in Biz (Pty) Ltd", proposed: "PiB Ltd" }]);
    expect(result.invalid.map((i) => i.field)).toEqual(["senderEmail", "mystery"]);
    expect(result.profile).toMatchObject({ legalName: "Partners in Biz (Pty) Ltd", website: "https://partnersinbiz.online" });
    expect(current).toEqual({ legalName: "Partners in Biz (Pty) Ltd", bannedWords: ["cheap"] });
  });

  it("people set or clear any field", () => {
    const { profile, changed } = applyEdit({ legalName: "Old", website: "https://a.co.za" }, { legalName: "New", website: "", audience: "SMEs in KZN" });
    expect(changed).toEqual(["legalName", "website", "audience"]);
    expect(profile).toEqual({ legalName: "New", audience: "SMEs in KZN" });
    expect(() => applyEdit({}, { senderEmail: "bad", vatNumber: "1" })).toThrow(/VAT.*email address/);
    expect(missingFields({ legalName: "X" })).toHaveLength(PROFILE_FIELDS.length - 1);
  });
});

describe("profile tools and actions", () => {
  it("company-profile reads it; update-company-profile fills empty fields and says what it kept", async () => {
    const s = setup();
    const empty = await s.tool("company-profile", {});
    expect(empty.error).toBeUndefined();
    expect(empty.content).toMatch(/^Company profile: 0 of 12 fields set/);
    expect(empty.data).toMatchObject({ href: "/PIB/cockpit?tab=profile", missing: expect.arrayContaining(["legalName", "brandVoice"]) });

    const filled = await s.tool("update-company-profile", { website: "partnersinbiz.online", brandVoice: "Plain, warm, South African English.", issueId: "PIB-3" });
    expect(filled.error).toBeUndefined();
    expect(filled.content).toBe("Filled website and brand voice.");
    expect(filled.data.filled).toEqual(["website", "brandVoice"]);

    // The owner sets the legal name; an agent cannot change it.
    await s.actions.get("profile.save")!({ profile: { legalName: "Partners in Biz (Pty) Ltd" } }, user);
    const kept = await s.tool("update-company-profile", { legalName: "PiB", senderName: "Peet" });
    expect(kept.content).toContain("Filled sender name.");
    expect(kept.content).toContain('Kept as they are (already set; only the owner changes them, so ask with ask-owner and quote the new value): Legal name is "Partners in Biz (Pty) Ltd"');
    expect((await s.tool("update-company-profile", { vatNumber: "12" })).error).toMatch(/10 digits/);
    expect((await s.tool("update-company-profile", {})).error).toMatch(/at least one field/);

    const read = await s.tool("company-profile", {});
    expect(read.data.profile).toMatchObject({ legalName: "Partners in Biz (Pty) Ltd", website: "https://partnersinbiz.online", senderName: "Peet" });
    expect(read.data.filledByAgents).toEqual(["website", "brandVoice", "senderName"]);
  });

  it("only board users save; the load action returns who filled what", async () => {
    const s = setup();
    await expect(s.actions.get("profile.save")!({ profile: { legalName: "X" } }, { companyId: A, actor: { type: "agent", agentId: "op" } })).rejects.toThrow(/Only a board user/);
    await expect(s.actions.get("profile.save")!({ profile: { senderEmail: "nope" } }, user)).rejects.toThrow(/email address/);
    const saved = (await s.actions.get("profile.save")!({ profile: { legalName: "PiB (Pty) Ltd", senderEmail: "hello@pib.co.za" } }, user)) as { changed: string[] };
    expect(saved.changed).toEqual(["legalName", "senderEmail"]);
    const loaded = (await s.actions.get("profile.load")!({}, user)) as { profile: Record<string, unknown>; filledBy: Record<string, { by: string; id: string }> };
    expect(loaded.profile).toEqual({ legalName: "PiB (Pty) Ltd", senderEmail: "hello@pib.co.za" });
    expect(loaded.filledBy.legalName).toMatchObject({ by: "person", id: "user-1" });
  });

  it("the setup item is done once the fields agents need are set", async () => {
    const s = setup();
    const before = (await ownSetupStatus(s.env, A)).items.find((i) => i.key === "company_profile")!;
    expect(before).toMatchObject({ status: "missing", required: true, href: "/cockpit?tab=profile" });
    expect(before.detail).toContain("legal name, website, sender email, what we sell and brand voice");
    await s.actions.get("profile.save")!({ profile: { legalName: "PiB (Pty) Ltd", website: "pib.co.za", senderEmail: "hi@pib.co.za", whatWeSell: "Growth retainers", brandVoice: "Plain and warm." } }, user);
    expect((await ownSetupStatus(s.env, A)).items.find((i) => i.key === "company_profile")).toMatchObject({ status: "done" });
  });
});

describe("the Profile tab", () => {
  const stored = { profile: { legalName: "PiB (Pty) Ltd", website: "https://pib.co.za", bannedWords: ["cheap", "guaranteed"] }, filledBy: { website: { by: "agent" as const, id: "op", at: "2026-09-26T10:00:00.000Z" } }, updatedAt: "2026-09-26T10:00:00.000Z" };
  const render = (draft = draftFrom(stored.profile), message: { text: string; tone: "ok" | "bad" } | null = null) =>
    renderToStaticMarkup(createElement(ProfileForm, { stored, draft, busy: false, message, onChange: () => undefined, onSave: () => undefined, onReset: () => undefined }));

  it("renders every field in its group, marks agent-filled ones and what is still needed", () => {
    const html = render();
    for (const text of ["Company profile", "Who we are", "Online", "Email", "What we do", "Brand voice", "Legal name", "VAT number", "Booking link", "Sender email", "Banned words", "3 of 12 set", "Filled in by an agent on 26 Sep: check it.", "Agents still need the sender email, what we sell and brand voice", "Save profile"]) expect(html, text).toContain(text);
    expect(html).toContain("cheap\nguaranteed");
    // Phone-friendly: fields wrap to one column; no fixed widths.
    expect(html).toContain("minmax(min(260px, 100%), 1fr)");
    expect(html.match(/(?<![-\w])width:\s?[3-9]\d{2,}px/g)).toBeNull();
    // Nothing changed yet: Save is off.
    expect(html).toMatch(/<button type="submit" disabled=""[^>]*>Save profile<\/button>/);
  });

  it("shows field errors and enables Save for a valid change", () => {
    const bad = { ...draftFrom(stored.profile), senderEmail: "nope" };
    expect(draftErrors(bad)).toEqual({ senderEmail: "Sender email must be an email address, e.g. hello@example.co.za." });
    expect(render(bad)).toContain('role="alert"');
    const good = { ...draftFrom(stored.profile), senderEmail: "hi@pib.co.za" };
    expect(render(good)).toMatch(/<button type="submit" style="[^"]*">Save profile<\/button>/);
    expect(render(good, { text: "Saved 1 change.", tone: "ok" })).toContain("Saved 1 change.");
    expect(agentNote({ by: "person", id: "u", at: "x" })).toBeNull();
  });
});
