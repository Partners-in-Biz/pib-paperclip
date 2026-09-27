import { describe, expect, it } from "vitest";
import { applyProfilePatch, profilePatch } from "../src/lookup.js";
import { BOARD, CO, boot, seed, tool, toolRaw } from "./helpers/crm.js";

describe("find-records", () => {
  it("finds by name, email, domain, phone and tag, with refs and links", async () => {
    const { harness } = await boot();
    const byName = await tool(harness, "find-records", { query: "acme" });
    expect(byName.results[0]).toEqual({
      ref: "company:acme", kind: "company", id: "acme", name: "Acme Plumbing", lifecycle: "prospect", domain: "acme.co.za", tags: ["retainer"], match: ["name", "domain"], link: "/PIB/crm?client=company%3Aacme",
    });
    expect((await tool(harness, "find-records", { query: "ada@acme.co.za" })).results.map((r: { ref: string }) => r.ref)).toEqual(["contact:ada", "company:acme"]);
    expect((await tool(harness, "find-records", { query: "globex.test", kind: "company" })).results.map((r: { ref: string }) => r.ref)).toEqual(["company:globex"]);
    // 082 123 4567 and +27 82 123 4567 are the same number.
    expect((await tool(harness, "find-records", { query: "082 123 4567" })).results).toEqual([expect.objectContaining({ ref: "contact:ada", match: ["phone"], companies: ["Acme Plumbing"] })]);
    expect((await tool(harness, "find-records", { query: "decision-maker" })).results).toEqual([expect.objectContaining({ ref: "contact:ada", match: ["tag"] })]);
  });

  it("filters by lifecycle and kind, caps the limit, and says what to do when nothing matches", async () => {
    const { harness } = await boot();
    expect((await tool(harness, "find-records", { lifecycle: "customer" })).results.map((r: { ref: string }) => r.ref)).toEqual(["contact:solo"]);
    const capped = await tool(harness, "find-records", { query: "o", limit: 1 });
    expect(capped.results).toHaveLength(1);
    expect(capped.more).toMatch(/more: narrow the query/);
    const none = await tool(harness, "find-records", { query: "zzz" });
    expect(none).toMatchObject({ total: 0, results: [] });
    expect(none.next).toMatch(/before you create a record/);
    expect((await toolRaw(harness, "find-records", {})).error).toMatch(/Give a query/);
    expect((await toolRaw(harness, "find-records", { query: "a", kind: "deal" })).error).toMatch(/kind must be company, contact or any/);
    // Another Paperclip company's record never shows.
    expect((await tool(harness, "find-records", { query: "foreign" })).results).toEqual([]);
  });

  it("returns the JSON in the text content too, so any client sees the ids", async () => {
    const { harness } = await boot();
    const raw = await toolRaw(harness, "find-records", { query: "globex" });
    const parsed = JSON.parse(raw.content!) as { results: Array<{ ref: string }> };
    // The company named Globex first, then the contact whose email is on its domain.
    expect(parsed.results.map((r) => r.ref)).toEqual(["company:globex", "contact:grace"]);
  });
});

describe("get-company and get-contact", () => {
  it("a company: profile, people, open deals, last 10 activities and workspace links", async () => {
    const store = seed();
    store.activities = Array.from({ length: 12 }, (_, i) => ({
      id: `a${i}`, company_id: CO, record_type: "company", record_id: "acme", kind: "note", body: `Note ${i}`, issue_id: null, created_at: `2026-09-${String(10 + i).padStart(2, "0")}T08:00:00Z`,
    }));
    store.client_profiles = [{ id: "pr1", company_id: CO, client_kind: "company", client_ref: "acme", brand_voice: "Warm and plain", audience: null, services: ["SEO retainer"], website: "https://acme.co.za", booking_link: null, banned_words: [], tone_notes: null, human_owned: [], updated_by: null, updated_at: "2026-09-20T00:00:00Z" }];
    const { harness } = await boot({ store });
    const acme = await tool(harness, "get-company", { companyRecordId: "company:acme" });
    expect(acme).toMatchObject({ ref: "company:acme", name: "Acme Plumbing", lifecycle: "prospect", domain: "acme.co.za", wonDeals: 0 });
    expect(acme.people).toEqual([{ ref: "contact:ada", name: "Ada Lovelace", role: "owner", email: "ada@acme.co.za", phone: "+27 82 123 4567", lifecycle: "lead", emailStatus: "ok" }]);
    expect(acme.openDeals).toEqual([expect.objectContaining({ id: "d-acme", stage: "Proposal", status: "open", client: "company:acme", contact: "contact:ada", amountMinor: 100_000 })]);
    expect(acme.activities).toHaveLength(10);
    expect(acme.activities[0]).toMatchObject({ kind: "note", text: "Note 11" });
    expect(acme.profile).toMatchObject({ brandVoice: "Warm and plain", services: ["SEO retainer"], missing: ["audience", "bookingLink", "bannedWords", "toneNotes"] });
    expect(acme.workspaceLinks).toEqual({
      crm: "/PIB/crm?client=company%3Aacme",
      social: "/PIB/social?client=company%3Aacme",
      seo: "/PIB/seo?client=company%3Aacme",
      campaigns: "/PIB/campaigns?client=company%3Aacme",
      billing: "/PIB/billing?client=company%3Aacme",
    });
    expect((await toolRaw(harness, "get-company", { companyRecordId: "foreign" })).error).toMatch(/not found or is not visible/);
  });

  it("a contact: companies, open deals, running sequences; a sole trader has a profile", async () => {
    const store = seed();
    store.enrollments = [{ id: "e1", company_id: CO, sequence_id: "seq-intro", contact_id: "solo", status: "running", step_position: 1, next_due_at: "2026-10-01T08:00:00Z", open_issue_id: null, sending_key: null, mail_thread_id: null, mail_last_message_id: null, created_at: "2026-09-01T00:00:00Z" }];
    const { harness } = await boot({ store });
    const solo = await tool(harness, "get-contact", { contactId: "solo" });
    expect(solo).toMatchObject({ ref: "contact:solo", emailStatus: "ok", companies: [], openDeals: [expect.objectContaining({ id: "d-solo", client: "contact:solo" })] });
    expect(solo.sequences).toEqual([{ enrollmentId: "e1", sequenceId: "seq-intro", name: "Intro", step: 1, nextDueAt: "2026-10-01T08:00:00Z" }]);
    expect(solo.profile).toMatchObject({ missing: expect.arrayContaining(["brandVoice"]) });
    const ada = await tool(harness, "get-contact", { contactId: "contact:ada" });
    expect(ada.companies).toEqual([{ ref: "company:acme", name: "Acme Plumbing", role: "owner", lifecycle: "prospect" }]);
    // At a company, the company holds the profile.
    expect(ada.profile).toBeNull();
  });
});

describe("list-deals, list-stages and list-sequences", () => {
  it("filters deals by status, stage and client", async () => {
    const store = seed();
    store.deals!.push({ ...store.deals![0]!, id: "d-won", title: "Old win", stage_id: "st-won" });
    const { harness } = await boot({ store });
    expect((await tool(harness, "list-deals", {})).total).toBe(3);
    expect((await tool(harness, "list-deals", { status: "won" })).deals.map((d: { id: string }) => d.id)).toEqual(["d-won"]);
    expect((await tool(harness, "list-deals", { stage: "proposal" })).deals.map((d: { id: string }) => d.id)).toEqual(["d-acme"]);
    expect((await tool(harness, "list-deals", { client: "contact:solo" })).deals.map((d: { id: string }) => d.id)).toEqual(["d-solo"]);
    expect((await tool(harness, "list-deals", { client: "company:acme", status: "open" })).deals.map((d: { id: string }) => d.id)).toEqual(["d-acme"]);
    expect((await toolRaw(harness, "list-deals", { stage: "Nope" })).error).toMatch(/No stage called Nope/);
    expect((await toolRaw(harness, "list-deals", { client: "acme" })).error).toMatch(/client must be company:<id> or contact:<id>/);
  });

  it("lists stages with ids and counts, and sequences with delivery, steps and running counts", async () => {
    const store = seed();
    store.enrollments = [{ id: "e1", company_id: CO, sequence_id: "seq-intro", contact_id: "ada", status: "running", step_position: 1, next_due_at: null, open_issue_id: null, sending_key: null, created_at: "2026-09-01T00:00:00Z" }];
    const { harness } = await boot({ store });
    const stages = await tool(harness, "list-stages", {});
    expect(stages.stages).toEqual([
      { id: "st-open", name: "Discovery", kind: "open", deals: 1 },
      { id: "st-prop", name: "Proposal", kind: "open", deals: 1 },
      { id: "st-won", name: "Won", kind: "won", deals: 0 },
      { id: "st-lost", name: "Lost", kind: "lost", deals: 0 },
    ]);
    const sequences = await tool(harness, "list-sequences", {});
    expect(sequences.sequences).toEqual([
      { id: "seq-mail", name: "Cold email", delivery: "email", completionMode: "sent", emailApproved: true, steps: [{ position: 1, delayMinutes: 0, title: "Hi {{first_name}}" }], running: 0 },
      { id: "seq-intro", name: "Intro", delivery: "issue", completionMode: "manual", steps: [{ position: 1, delayMinutes: 0, title: "Say hello" }, { position: 2, delayMinutes: 1440, title: "Follow up" }], running: 1 },
    ].sort((a, b) => a.name.localeCompare(b.name)));
  });
});

describe("the client profile", () => {
  it("an agent fills it in; a person's values are kept", async () => {
    const { harness, store } = await boot();
    const filled = await tool(harness, "update-client-profile", {
      client: "company:acme",
      brandVoice: "Warm, plain South African English.",
      services: ["SEO retainer", "Social media"],
      website: "acme.co.za",
      bannedWords: "cheap; guaranteed",
    });
    expect(filled).toMatchObject({ client: "company:acme", changed: ["brandVoice", "services", "website", "bannedWords"], refused: [] });
    expect(filled.profile).toMatchObject({ website: "https://acme.co.za", bannedWords: ["cheap", "guaranteed"], missing: ["audience", "bookingLink", "toneNotes"] });
    expect(store.client_profiles).toHaveLength(1);

    // A person changes the brand voice in the UI: it is theirs now.
    await harness.performAction("crm.update-client-profile", { client: "company:acme", brandVoice: "Cheerful and short." }, { companyId: CO, actor: BOARD });
    const refused = await toolRaw(harness, "update-client-profile", { client: "company:acme", brandVoice: "Formal.", audience: "Homeowners in Durban North." });
    expect(refused.error).toMatch(/Refused to overwrite human-owned fields: brandVoice/);
    const read = await tool(harness, "get-client-profile", { client: "company:acme" });
    expect(read.profile).toMatchObject({ brandVoice: "Cheerful and short.", audience: "Homeowners in Durban North." });
    expect(read.humanOwned).toEqual(["brandVoice"]);
    expect(read.next).toMatch(/Missing: bookingLink, toneNotes/);
  });

  it("validates fields", async () => {
    const { harness } = await boot();
    expect((await toolRaw(harness, "update-client-profile", { client: "company:acme", website: "not a site" })).error).toMatch(/website must be a web address/);
    expect((await toolRaw(harness, "update-client-profile", { client: "company:acme" })).error).toMatch(/at least one profile field/);
    expect((await toolRaw(harness, "get-client-profile", { client: "company:foreign" })).error).toMatch(/not visible/);
    expect(profilePatch({ services: "a, b,, a" })).toEqual({ services: ["a", "b"] });
    const agentFill = applyProfilePatch({ ...{ brandVoice: null, audience: null, services: [], website: null, bookingLink: null, bannedWords: [], toneNotes: null }, id: "x", companyId: CO, clientKind: "company", clientRef: "acme", humanOwned: ["brandVoice"], updatedBy: null, updatedAt: null }, { brandVoice: "Filled while empty" }, "agent");
    expect(agentFill).toMatchObject({ changed: ["brandVoice"], refused: [] });
  });

  it("the client workspace carries the profile and the client's own leads", async () => {
    const store = seed();
    store.client_leads = [{ id: "cl1", key: "social:inbox:1", company_id: CO, client_kind: "company", client_ref: "acme", source: "social", platform: "instagram", name: "Jane", handle: "jane", email: null, message: "Price?", url: null, item_id: "1", confidence: 0.9, captured_at: "2026-09-27T08:00:00Z" }];
    const { harness } = await boot({ store });
    const ws = await harness.performAction<Record<string, any>>("crm.client-workspace", { client: "company:acme" }, { companyId: CO, actor: BOARD });
    expect(ws.profile).toBeNull();
    expect(ws.clientLeads).toEqual([expect.objectContaining({ key: "social:inbox:1", name: "Jane", message: "Price?", itemId: "1" })]);
  });
});

describe("export-contacts", () => {
  it("carries ids, refs, email status and company refs", async () => {
    const { harness } = await boot();
    const out = await tool(harness, "export-contacts", {});
    const [header, ...rows] = String(out.csv).split("\n");
    expect(header).toBe("id,ref,name,emails,phones,lifecycle,email_status,tags,companies");
    expect(rows).toContain("ada,contact:ada,Ada Lovelace,ada@acme.co.za,+27 82 123 4567,lead,ok,decision-maker,company:acme");
    expect(out.count).toBe(3);
  });
});
