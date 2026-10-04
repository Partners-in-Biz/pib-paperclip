import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { REGISTER_DOC } from "../src/register-doc.generated.js";
import { CLIENT_SENSITIVITY_EVENT, listRegister, parseRegisterDoc, REGISTER, reemitSensitivity, ruleOf, seedRegister, sensitivityOf, systemsNotCleared } from "../src/register.js";
import { BOARD, bootCare, careSeed, CO, tool, toolRaw } from "./helpers/care.js";

const DOC = readFileSync(new URL("../docs/data-processing-register.md", import.meta.url), "utf8");

const GOOD = `Version: 1
<!-- register:start -->
| id | name | role | purpose | data | region | retention | agreement | safeguards | sensitive clients | owner action |
|---|---|---|---|---|---|---|---|---|---|---|
| alpha | Alpha | Host | Runs it | emails, names | EU | 1 year | on file | encrypted | cleared (own server) | |
| beta | Beta | AI | Models | text | US | unknown | unverified | none | not cleared | Ask them |
<!-- register:end -->`;

describe("the data-processing register file", () => {
  it("is embedded in the worker exactly as written, so a changed file without a rebuild fails here", () => {
    expect(REGISTER_DOC).toBe(DOC);
  });

  it("names every system the owner listed, each with its region, retention, agreement, safeguards and rule for sensitive clients", () => {
    const ids = REGISTER.rows.map((row) => row.id);
    for (const system of ["anthropic", "hermes-nous", "typesafe", "resend", "google", "cloudflare-r2", "hetzner", "github", "vercel", "firebase"]) expect(ids, system).toContain(system);
    expect(REGISTER.version).toBe("2026-10-04");
    for (const row of REGISTER.rows) {
      expect(row.region.length, row.id).toBeGreaterThan(1);
      expect(row.retention.length, row.id).toBeGreaterThan(1);
      expect(row.agreement.length, row.id).toBeGreaterThan(1);
      expect(row.safeguards.length, row.id).toBeGreaterThan(1);
      expect(row.dataClasses.length, row.id).toBeGreaterThan(0);
      expect(ruleOf(row), row.id).not.toBeNull();
    }
  });

  it("never claims an agreement it has not seen: every outside processor is unverified or not applicable, and none is cleared for a sensitive client", () => {
    for (const row of REGISTER.rows) {
      if (row.id === "hetzner") continue;
      expect(row.agreement, row.id).toMatch(/^(unverified|not applicable)/i);
      expect(ruleOf(row), row.id).not.toBe("cleared");
    }
    expect(ruleOf(REGISTER.rows.find((row) => row.id === "hetzner")!)).toBe("cleared");
    expect(systemsNotCleared()).not.toContain("Hetzner (the Paperclip server)");
    expect(systemsNotCleared()).toContain("Anthropic (Claude)");
    // Each unverified system says the one thing to check.
    for (const row of REGISTER.rows.filter((r) => /^unverified/i.test(r.agreement))) expect(row.ownerAction, row.id).toBeTruthy();
  });

  it("parses a table and refuses a malformed file", () => {
    const doc = parseRegisterDoc(GOOD);
    expect(doc.version).toBe("1");
    expect(doc.rows).toHaveLength(2);
    expect(doc.rows[0]).toMatchObject({ id: "alpha", dataClasses: ["emails", "names"], ownerAction: null });
    expect(ruleOf(doc.rows[1]!)).toBe("not cleared");
    expect(() => parseRegisterDoc(GOOD.replace("Version: 1\n", ""))).toThrow(/Version/);
    expect(() => parseRegisterDoc(GOOD.replace("<!-- register:end -->", ""))).toThrow(/markers/);
    expect(() => parseRegisterDoc(GOOD.replace("| id | name", "| ident | name"))).toThrow(/header must be/);
    expect(() => parseRegisterDoc(GOOD.replace("| beta |", "| alpha |"))).toThrow(/appears twice/);
    expect(() => parseRegisterDoc(GOOD.replace("not cleared", "maybe"))).toThrow(/must start with cleared/);
    expect(() => parseRegisterDoc(GOOD.replace("| EU |", "| EU | extra |"))).toThrow(/columns/);
    expect(() => parseRegisterDoc(GOOD.replace("| Models |", "|  |"))).toThrow(/empty cell/);
    expect(() => parseRegisterDoc(GOOD.replace("| alpha |", "| Alpha Beta |"))).toThrow(/lower-case/);
  });
});

describe("the register table", () => {
  it("is seeded per company from the file, once, and follows the file when it changes", async () => {
    const { harness, store } = await bootCare();
    expect(await seedRegister(harness.ctx, CO)).toBe(REGISTER.rows.length);
    expect(await seedRegister(harness.ctx, CO)).toBe(0);
    const rows = await listRegister(harness.ctx, CO);
    expect(rows.map((row) => row.id).sort()).toEqual(REGISTER.rows.map((row) => row.id).sort());
    expect(rows.every((row) => row.docVersion === REGISTER.version)).toBe(true);
    expect(store.processing_register!.every((row) => row.company_id === CO)).toBe(true);
    // A new version of the file updates what changed; a row taken out of the file is taken out of the table.
    const changed = parseRegisterDoc(GOOD);
    const written = await seedRegister(harness.ctx, CO, changed);
    expect(written).toBe(2 + REGISTER.rows.length);
    expect((await listRegister(harness.ctx, CO)).map((row) => row.id)).toEqual(["alpha", "beta"]);
    // Another company's rows are never touched.
    store.processing_register!.push({ company_id: "co-2", system_id: "theirs", name: "Theirs", role: "x", purpose: "x", data_classes: [], region: "x", retention: "x", agreement: "x", safeguards: "x", sensitive_clients: "cleared", owner_action: null, doc_version: "0" });
    await seedRegister(harness.ctx, CO);
    expect(store.processing_register!.some((row) => row.company_id === "co-2" && row.system_id === "theirs")).toBe(true);
  });

  it("is read through a tool that cannot change it, and can be narrowed to what a sensitive client must avoid", async () => {
    const { harness } = await bootCare();
    const all = await tool<Record<string, any>>(harness, "list-data-processing", {});
    expect(all).toMatchObject({ version: "2026-10-04", count: REGISTER.rows.length });
    expect(all.agreementsUnverified).toBeGreaterThan(5);
    expect(all.systems.find((s: any) => s.id === "hetzner")).toMatchObject({ name: expect.stringMatching(/Hetzner/), sensitiveClients: expect.stringMatching(/^cleared/) });
    const avoid = await tool<Record<string, any>>(harness, "list-data-processing", { forSensitiveClient: true });
    expect(avoid.systems.map((s: any) => s.id)).not.toContain("hetzner");
    expect(avoid.count).toBe(REGISTER.rows.length - 1);
    expect(avoid.note).toMatch(/Read-only/);
  });
});

describe("client sensitivity", () => {
  it("an agent may raise it with a reason; it is stored, told to everyone, and the profile says what to keep it off", async () => {
    const { harness, store, emit } = await bootCare();
    expect((await toolRaw(harness, "set-client-sensitivity", { client: "company:acme", level: "sensitive" })).error).toMatch(/Say why/);
    const set = await tool<Record<string, any>>(harness, "set-client-sensitivity", { client: "company:acme", level: "sensitive", reason: "Acme is a clinic: patient names are in the leads." });
    expect(set).toMatchObject({ level: "sensitive", client: "company:acme" });
    expect(set.keepOffSystems).toContain("Anthropic (Claude)");
    expect(set.keepOffSystems).not.toContain("Hetzner (the Paperclip server)");
    expect(store.client_sensitivity![0]).toMatchObject({ client_kind: "company", client_ref: "acme", level: "sensitive", set_by: "agent:agent-1" });
    const told = emit.mock.calls.find((call) => call[0] === CLIENT_SENSITIVITY_EVENT)![2] as Record<string, any>;
    expect(told).toMatchObject({ clientKind: "company", clientRef: "acme", level: "sensitive", reason: "Acme is a clinic: patient names are in the leads." });
    expect(told.keepOffSystems).toContain("Nous Research and DeepSeek (through Hermes)");
    const profile = await tool<Record<string, any>>(harness, "get-client-profile", { client: "company:acme" });
    expect(profile.sensitivity).toMatchObject({ level: "sensitive", reason: "Acme is a clinic: patient names are in the leads." });
    expect(profile.sensitivity.keepOffSystems.length).toBeGreaterThan(5);
    expect((await sensitivityOf(harness.ctx, CO, { kind: "company", id: "globex" })).level).toBe("standard");
    // Saying the same again changes nothing and says nothing more.
    const same = await tool<Record<string, any>>(harness, "set-client-sensitivity", { client: "company:acme", level: "sensitive", reason: "Acme is a clinic: patient names are in the leads." });
    expect(same.unchanged).toBe(true);
    expect(emit.mock.calls.filter((call) => call[0] === CLIENT_SENSITIVITY_EVENT)).toHaveLength(1);
  });

  it("only a person lowers it", async () => {
    const { harness, store } = await bootCare();
    await tool(harness, "set-client-sensitivity", { client: "company:acme", level: "sensitive", reason: "Acme handles children's data." });
    expect((await toolRaw(harness, "set-client-sensitivity", { client: "company:acme", level: "standard" })).error).toMatch(/Only a person can lower/);
    expect(store.client_sensitivity![0]!.level).toBe("sensitive");
    const lowered = await harness.performAction<Record<string, any>>("crm.set-client-sensitivity", { client: "company:acme", level: "standard", reason: "Contract changed." }, { companyId: CO, actor: BOARD });
    expect(lowered).toMatchObject({ level: "standard", keepOffSystems: [] });
    expect(store.client_sensitivity![0]).toMatchObject({ level: "standard" });
  });

  it("is said again every night for each sensitive client, and goes when the client does", async () => {
    const { harness, store, emit } = await bootCare({ store: careSeed() });
    await tool(harness, "set-client-sensitivity", { client: "company:acme", level: "sensitive", reason: "Acme is a clinic: patient names are in the leads." });
    await tool(harness, "set-client-sensitivity", { client: "company:globex", level: "standard" }).catch(() => undefined);
    emit.mockClear();
    expect(await reemitSensitivity(harness.ctx, CO)).toBe(1);
    expect(emit.mock.calls.filter((call) => call[0] === CLIENT_SENSITIVITY_EVENT)).toHaveLength(1);
    await harness.performAction("crm.delete-company", { companyRecordId: "acme", confirm: true }, { companyId: CO, actor: BOARD });
    expect(store.client_sensitivity ?? []).toHaveLength(0);
  });
});
