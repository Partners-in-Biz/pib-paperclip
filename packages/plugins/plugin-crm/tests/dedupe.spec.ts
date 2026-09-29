import { describe, expect, it } from "vitest";
import { fillContact, normalizeDomain, phoneMatchKey, type ContactDraft } from "../src/domain.js";
import { boot, CO, contact, seed, setRoles, tool } from "./helpers/crm.js";

describe("matching keys", () => {
  it("phones match on their last 9 digits, however they are written", () => {
    expect(phoneMatchKey("082 123 4567")).toBe("821234567");
    expect(phoneMatchKey("+27 (82) 123-4567")).toBe("821234567");
    expect(phoneMatchKey("27821234567")).toBe("821234567");
    expect(phoneMatchKey("12345")).toBeNull();
  });

  it("websites compare as bare domains", () => {
    expect(normalizeDomain("https://www.Acme.co.za/about?x=1")).toBe("acme.co.za");
    expect(normalizeDomain("acme.co.za")).toBe("acme.co.za");
    expect(normalizeDomain("info@acme.co.za")).toBe("acme.co.za");
    expect(normalizeDomain("localhost")).toBeNull();
    expect(normalizeDomain("")).toBeNull();
  });
});

describe("fillContact", () => {
  const base = (): ContactDraft => ({
    id: "c1", companyId: CO, name: "jaco@intellidrive.co.za", emails: ["jaco@intellidrive.co.za"], phones: [], lifecycle: "lead",
    custom: { source: "form" }, humanOwned: [], ownerUserId: null, assigneeAgentId: null, tags: ["lead"], nextActionKind: null, nextActionDueAt: null,
  } as unknown as ContactDraft);

  it("fills what is empty and adds what is missing, never overwriting", () => {
    const c = base();
    const changed = fillContact(c, {
      name: "Jaco van Niekerk",
      emails: ["JACO@intellidrive.co.za", "jaco@gmail.test"],
      phones: ["082 000 1111"],
      tags: ["Lead", "referral"],
      custom: { source: "import", role: "Owner" },
    });
    expect(c.name).toBe("Jaco van Niekerk");
    expect(c.emails).toEqual(["jaco@intellidrive.co.za", "jaco@gmail.test"]);
    expect(c.phones).toEqual(["082 000 1111"]);
    expect(c.tags).toEqual(["lead", "referral"]);
    expect(c.custom).toEqual({ source: "form", role: "Owner" });
    expect(changed).toEqual(["name", "emails", "phones", "tags", "role"]);
  });

  it("keeps a real name and a field a person owns", () => {
    const c = { ...base(), name: "Jaco", humanOwned: ["emails"] } as ContactDraft;
    expect(fillContact(c, { name: "Jaco van Niekerk", emails: ["other@x.test"] })).toEqual([]);
    expect(c.name).toBe("Jaco");
    expect(c.emails).toEqual(["jaco@intellidrive.co.za"]);
  });
});

describe("one record per person and company", () => {
  it("create-contact with an email we have updates that contact instead", async () => {
    const { harness, store } = await boot();
    const out = await tool(harness, "create-contact", { name: "Ada L.", emails: [" ADA@acme.co.za "], tags: ["newsletter"] });
    expect(out).toMatchObject({ id: "ada", matched: true, matchedOn: "email ada@acme.co.za", filled: ["tags"] });
    expect(store.contacts!.filter((row) => row.company_id === CO)).toHaveLength(3);
    expect(store.contacts!.find((row) => row.id === "ada")!.name).toBe("Ada Lovelace");
    expect(store.activities!.some((a) => a.record_id === "ada" && /no second record/.test(String(a.body)))).toBe(true);
  });

  it("matches on the phone when the email is new", async () => {
    const { harness, store } = await boot();
    const out = await tool(harness, "create-contact", { name: "Ada", emails: ["ada@home.test"], phones: ["082 123 4567"] });
    expect(out).toMatchObject({ id: "ada", matched: true, matchedOn: "phone 082 123 4567" });
    expect(store.contacts!.find((row) => row.id === "ada")!.emails).toEqual(["ada@acme.co.za", "ada@home.test"]);
  });

  it("creates a new contact, with lower-case emails, when nothing matches", async () => {
    const { harness, store } = await boot();
    const out = await tool(harness, "create-contact", { name: "Nia New", emails: ["Nia@New.test"] });
    expect(out.matched).toBeUndefined();
    expect(store.contacts!.find((row) => row.id === out.id)!.emails).toEqual(["nia@new.test"]);
  });

  it("import-contacts updates people we have, and people listed twice in the file", async () => {
    const { harness, store } = await boot();
    const csv = ["name,emails,phones,tags", "Ada,ada@acme.co.za,,vip", "Nia New,nia@new.test,,", "Nia N.,NIA@new.test,,imported"].join("\n");
    expect(await tool(harness, "import-contacts", { csv })).toEqual({ created: 1, updated: 2 });
    const nia = store.contacts!.filter((row) => (row.emails as string[]).includes("nia@new.test"));
    expect(nia).toHaveLength(1);
    expect(nia[0]!.tags).toEqual(["imported"]);
  });

  it("create-company with a website we have returns that company", async () => {
    const { harness, store } = await boot();
    const byDomain = await tool(harness, "create-company", { name: "Acme Plumbing (Pty) Ltd", domain: "https://www.acme.co.za/" });
    expect(byDomain).toMatchObject({ id: "acme", matched: true, matchedOn: "website acme.co.za" });
    const byName = await tool(harness, "create-company", { name: "globex", tags: ["partner"] });
    expect(byName).toMatchObject({ id: "globex", matched: true, filled: ["tags"] });
    expect(store.companies!.filter((row) => row.company_id === CO)).toHaveLength(2);
    const fresh = await tool(harness, "create-company", { name: "Initech", domain: "initech.test" });
    expect(fresh.matched).toBeUndefined();
  });
});

describe("merging two records of the same person", () => {
  /** Both Adas work at Acme and both are running the intro sequence. */
  const twoAdas = () => {
    const store = seed();
    store.contacts!.push(contact("ada-dup", "Ada L.", { emails: ["ada@acme.co.za"] }));
    store.contact_companies!.push({ id: "l3", company_id: CO, contact_id: "ada-dup", account_id: "acme", role_label: "staff", created_at: "2026-02-01T00:00:00Z" });
    store.contact_companies!.push({ id: "l4", company_id: CO, contact_id: "ada-dup", account_id: "globex", role_label: "buyer", created_at: "2026-02-01T00:00:00Z" });
    store.enrollments!.push(
      { id: "e-ada", company_id: CO, sequence_id: "seq-intro", contact_id: "ada", status: "running", step_position: 1, next_due_at: null, open_issue_id: null },
      { id: "e-dup", company_id: CO, sequence_id: "seq-intro", contact_id: "ada-dup", status: "running", step_position: 1, next_due_at: null, open_issue_id: null },
    );
    return store;
  };

  it("merges when both contacts work at the same company, keeping one link each", async () => {
    const { harness, store } = await boot({ store: twoAdas() });
    expect(await tool(harness, "merge-contacts", { primaryContactId: "ada", duplicateContactId: "ada-dup" })).toMatchObject({ merged: true });
    const links = store.contact_companies!.filter((row) => row.contact_id === "ada");
    expect(links.map((row) => row.account_id).sort()).toEqual(["acme", "globex"]);
    expect(store.contact_companies!.some((row) => row.contact_id === "ada-dup")).toBe(false);
    expect(store.contacts!.some((row) => row.id === "ada-dup")).toBe(false);
  });

  it("keeps the primary's run of a sequence and stops the duplicate's", async () => {
    const { harness, store } = await boot({ store: twoAdas() });
    await tool(harness, "merge-contacts", { primaryContactId: "ada", duplicateContactId: "ada-dup" });
    const runs = store.enrollments!.filter((row) => row.contact_id === "ada");
    expect(runs).toHaveLength(2);
    expect(runs.filter((row) => row.status === "running").map((row) => row.id)).toEqual(["e-ada"]);
    expect(runs.find((row) => row.id === "e-dup")!.status).toBe("stopped");
  });
});

describe("sales work goes to the sales team, else the Account Manager", () => {
  const setLinked = async (harness: Awaited<ReturnType<typeof boot>>["harness"], role: string, agentId: string) => {
    harness.seed({ agents: [{ id: agentId, companyId: CO, name: agentId, status: "idle" } as never] });
    await harness.ctx.state.set({ scopeKind: "company", scopeId: CO, namespace: "pib-hire", stateKey: `role:${role}` }, { agentId, linkedAt: "2026-09-28T08:00:00Z", linkedBy: "manual", hire: null });
  };

  it("a new lead goes to the Inbound Qualifier when there is one", async () => {
    const { harness } = await boot();
    await setLinked(harness, "account-manager", "am-1");
    await setLinked(harness, "inbound-qualifier", "iq-1");
    await harness.emit("plugin.partnersinbiz.social.lead.captured", {
      key: "social:inbox:k1", source: "social", name: "Lee Lead", handle: "@k1", platform: "instagram", text: "Can you quote a website?", confidence: 0.9, capturedAt: "2026-09-28T08:00:00Z",
    }, { companyId: CO });
    const issues = await harness.ctx.issues.list({ companyId: CO, originKind: "plugin:partnersinbiz.crm" });
    const lead = issues.find((i) => /Lee Lead/.test(String(i.title)));
    expect(lead?.assigneeAgentId).toBe("iq-1");
  });

  it("without one, the Account Manager covers it", async () => {
    const { harness } = await boot();
    await setLinked(harness, "account-manager", "am-1");
    await harness.emit("plugin.partnersinbiz.social.lead.captured", {
      key: "social:inbox:k2", source: "social", name: "Lou Lead", handle: "@k2", platform: "instagram", text: "Can you quote a website?", confidence: 0.9, capturedAt: "2026-09-28T08:00:00Z",
    }, { companyId: CO });
    const issues = await harness.ctx.issues.list({ companyId: CO, originKind: "plugin:partnersinbiz.crm" });
    expect(issues.find((i) => /Lou Lead/.test(String(i.title)))?.assigneeAgentId).toBe("am-1");
  });

  it("the Cockpit's team map counts too, when the CRM has no link", async () => {
    const { harness } = await boot();
    await setRoles(harness, { team: { "inbound-qualifier": { agentId: "iq-9", status: "idle" } } });
    await harness.emit("plugin.partnersinbiz.social.lead.captured", {
      key: "social:inbox:k3", source: "social", name: "Liv Lead", handle: "@k3", platform: "instagram", text: "Can you quote a website?", confidence: 0.9, capturedAt: "2026-09-28T08:00:00Z",
    }, { companyId: CO });
    const issues = await harness.ctx.issues.list({ companyId: CO, originKind: "plugin:partnersinbiz.crm" });
    expect(issues.find((i) => /Liv Lead/.test(String(i.title)))?.assigneeAgentId).toBe("iq-9");
  });
});
