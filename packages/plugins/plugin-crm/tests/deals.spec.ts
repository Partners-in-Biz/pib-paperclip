import { describe, expect, it } from "vitest";
import manifest from "../src/manifest.js";
import { dayLabel } from "../src/setup-status.js";
import { CRM_MUTATIONS } from "../src/sync.js";
import { BOARD, CO, boot, seed, tool, toolRaw } from "./helpers/crm.js";

const emitted = (emit: { mock: { calls: unknown[][] } }, name: string) =>
  emit.mock.calls.filter(([event]) => event === name).map(([, , payload]) => payload as Record<string, any>);

const asPerson = { companyId: CO, actor: BOARD };

describe("the deal drawer: crm.update-deal", () => {
  it("a person edits the title and value and links the deal's client", async () => {
    const { harness, store } = await boot();
    const result = await harness.performAction<Record<string, any>>(
      "crm.update-deal",
      { dealId: "d-solo", title: " Solo website rebuild ", amountMinor: 2_000_000, companyRecordId: "company:globex", contactId: "grace" },
      asPerson,
    );
    expect(result).toMatchObject({ title: "Solo website rebuild", amountMinor: 2_000_000, accountId: "globex", contactId: "grace", client: "company:globex", stageName: "Discovery", stageKind: "open", refused: [] });
    const row = store.deals!.find((d) => d.id === "d-solo")!;
    expect(row).toMatchObject({ title: "Solo website rebuild", amount_minor: 2_000_000, account_id: "globex", contact_id: "grace" });
    // Every change is in the deal's field history.
    expect(store.facts!.filter((f) => f.record_id === "d-solo").map((f) => f.field_key).sort()).toEqual(["amountMinor", "companyRecordId", "contactId", "title"]);
  });

  it("an empty link unlinks; an unchanged one is not recorded again", async () => {
    const { harness, store } = await boot();
    await harness.performAction("crm.update-deal", { dealId: "d-acme", companyRecordId: "", contactId: "ada" }, asPerson);
    expect(store.deals!.find((d) => d.id === "d-acme")).toMatchObject({ account_id: null, contact_id: "ada" });
    expect(store.facts!.map((f) => f.field_key)).toEqual(["companyRecordId"]);
  });

  it("refuses another workspace's company, a bad value and an empty title", async () => {
    const { harness } = await boot();
    await expect(harness.performAction("crm.update-deal", { dealId: "d-solo", companyRecordId: "foreign" }, asPerson)).rejects.toThrow();
    await expect(harness.performAction("crm.update-deal", { dealId: "d-solo", amountMinor: -5 }, asPerson)).rejects.toThrow(/non-negative integer/);
    await expect(harness.performAction("crm.update-deal", { dealId: "d-solo", title: "  " }, asPerson)).rejects.toThrow(/title is required/);
    await expect(harness.performAction("crm.update-deal", { dealId: "nope", title: "x" }, asPerson)).rejects.toThrow(/Deal was not found/);
  });

  it("a stage change is a move: won makes the client a customer and tells Billing", async () => {
    const { harness, store, emit } = await boot();
    const result = await harness.performAction<Record<string, any>>("crm.update-deal", { dealId: "d-acme", amountMinor: 250_000, stageId: "st-won" }, asPerson);
    expect(result).toMatchObject({ stageKind: "won", stageName: "Won", amountMinor: 250_000, won: { firstWin: true, emitted: true } });
    expect(store.deals!.find((d) => d.id === "d-acme")).toMatchObject({ stage_id: "st-won", amount_minor: 250_000 });
    expect(store.companies!.find((c) => c.id === "acme")!.lifecycle).toBe("customer");
    expect(emitted(emit, "deal.won")).toEqual([expect.objectContaining({ dealId: "d-acme", valueMinor: 250_000 })]);
  });

  it("linking the client of a deal won without one does what the win could not", async () => {
    const store = seed();
    store.deals!.push({ ...store.deals![0]!, id: "d-orphan", title: "Mystery deal", account_id: null, contact_id: null, stage_id: "st-won" });
    const { harness, emit } = await boot({ store });
    const result = await tool(harness, "update-deal", { dealId: "d-orphan", companyRecordId: "company:globex" });
    expect(result).toMatchObject({ client: "company:globex", stageKind: "won", won: { emitted: true } });
    expect(store.companies!.find((c) => c.id === "globex")!.lifecycle).toBe("customer");
    expect(emitted(emit, "deal.won")).toEqual([expect.objectContaining({ dealId: "d-orphan", clientRef: "globex" })]);
    // Linking it again to someone else does not win it twice.
    await tool(harness, "update-deal", { dealId: "d-orphan", contactId: "grace" });
    expect(emitted(emit, "deal.won")).toHaveLength(1);
  });

  it("an agent cannot overwrite a field a person locked", async () => {
    const store = seed();
    store.deals![1]!.human_owned_fields = ["title"];
    const { harness } = await boot({ store });
    const refused = await toolRaw(harness, "update-deal", { dealId: "d-solo", title: "Renamed by an agent", amountMinor: 900_000 });
    expect(refused.error).toMatch(/Refused to overwrite human-owned fields: title/);
    expect(store.deals!.find((d) => d.id === "d-solo")).toMatchObject({ title: "Solo website", amount_minor: 900_000 });
  });

  it("is an agent tool and a CRM change like move-deal", () => {
    expect(manifest.tools?.map((t) => t.name)).toContain("update-deal");
    expect(CRM_MUTATIONS.has("update-deal")).toBe(true);
    expect(CRM_MUTATIONS.has("crm.update-deal")).toBe(true);
  });
});

describe("the sequence drawer: crm.sequence-detail", () => {
  it("lists the steps in order and who is enrolled", async () => {
    const store = seed();
    store.enrollments = [
      { id: "e1", company_id: CO, sequence_id: "seq-intro", contact_id: "ada", status: "running", step_position: 2, next_due_at: "2026-10-02T08:00:00Z", open_issue_id: null, sending_key: null, mail_thread_id: null, mail_last_message_id: null, created_at: "2026-09-20T00:00:00Z" },
      { id: "e2", company_id: CO, sequence_id: "seq-intro", contact_id: "grace", status: "done", step_position: 2, next_due_at: null, open_issue_id: null, sending_key: null, mail_thread_id: null, mail_last_message_id: null, created_at: "2026-09-21T00:00:00Z" },
    ];
    const { harness } = await boot({ store });
    const detail = await harness.performAction<Record<string, any>>("crm.sequence-detail", { sequenceId: "seq-intro" }, asPerson);
    expect(detail).toMatchObject({ id: "seq-intro", name: "Intro", delivery: "issue", completionMode: "manual", hidden: 0 });
    expect(detail.steps.map((step: { title: string; delayMinutes: number }) => [step.title, step.delayMinutes])).toEqual([["Say hello", 0], ["Follow up", 1440]]);
    expect(detail.enrolled).toEqual([
      { contactId: "ada", name: "Ada Lovelace", status: "running", stepPosition: 2, nextDueAt: "2026-10-02T08:00:00Z", issueId: null, sending: false },
      { contactId: "grace", name: "Grace Hopper", status: "done", stepPosition: 2, nextDueAt: null, issueId: null, sending: false },
    ]);
  });

  it("an unknown sequence is not found", async () => {
    const { harness } = await boot();
    await expect(harness.performAction("crm.sequence-detail", { sequenceId: "nope" }, asPerson)).rejects.toThrow(/Sequence was not found/);
  });
});

describe("client profile locks", () => {
  it("a person locks and unlocks profile fields; agents cannot", async () => {
    const { harness } = await boot();
    await tool(harness, "update-client-profile", { client: "company:acme", brandVoice: "Warm.", audience: "Homeowners." });
    const locked = await harness.performAction<Record<string, any>>("crm.update-client-profile", { client: "company:acme", humanOwned: ["audience", "brandVoice"] }, asPerson);
    expect(locked.humanOwned).toEqual(["brandVoice", "audience"]);
    expect((await toolRaw(harness, "update-client-profile", { client: "company:acme", audience: "Everyone." })).error).toMatch(/Refused to overwrite human-owned fields: audience/);
    const unlocked = await harness.performAction<Record<string, any>>("crm.update-client-profile", { client: "company:acme", humanOwned: ["brandVoice"] }, asPerson);
    expect(unlocked.humanOwned).toEqual(["brandVoice"]);
    expect(await tool(harness, "update-client-profile", { client: "company:acme", audience: "Everyone." })).toMatchObject({ changed: ["audience"], refused: [] });
    // An agent's humanOwned is ignored (the tool does not take it), so there is nothing to change.
    expect((await toolRaw(harness, "update-client-profile", { client: "company:acme", humanOwned: [] })).error).toMatch(/at least one profile field/);
    await expect(harness.performAction("crm.update-client-profile", { client: "company:acme", humanOwned: ["website", "shoeSize"] }, asPerson)).rejects.toThrow(/Not profile fields: shoeSize/);
  });
});

describe("dates people read", () => {
  it("says the day in South African time, never an ISO date", () => {
    expect(dayLabel("2026-09-27T10:00:00Z")).toBe("27 Sep 2026");
    // 23:30 UTC is already the next day in Johannesburg.
    expect(dayLabel("2026-09-27T23:30:00Z")).toBe("28 Sep 2026");
    expect(dayLabel("not a date")).toBe("not a date");
  });
});
