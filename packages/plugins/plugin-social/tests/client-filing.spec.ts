import { describe, expect, it } from "vitest";
import { assertClientFiling, clientsNamed, overrideTexts } from "../src/client-filing.js";
import type { CrmClient } from "../src/clients.js";
import * as db from "../src/db.js";
import { statsQuery } from "../src/stats.js";
import { fakeCtx } from "./helpers.js";

const VELOX: CrmClient = { kind: "company", id: "v1", name: "Velox", domain: "veloxmath.com", lifecycle: null, email: null };
const VELOX_DUP: CrmClient = { kind: "company", id: "v2", name: "Velox", domain: null, lifecycle: null, email: null };
const LUMEN: CrmClient = { kind: "company", id: "l1", name: "Lumen", domain: "lumenspeeds.com", lifecycle: null, email: null };
const MEND: CrmClient = { kind: "company", id: "m1", name: "Mend", domain: null, lifecycle: null, email: null };
const SAM: CrmClient = { kind: "contact", id: "s1", name: "Sam Smith", domain: null, lifecycle: null, email: null };
const CLIENTS = [VELOX, VELOX_DUP, LUMEN, MEND, SAM];

function ctxWith(clients: CrmClient[]) {
  return fakeCtx({}, {
    queryResult: (sql) => {
      if (sql.includes("crm_companies")) return clients.filter((c) => c.kind === "company").map((c) => ({ id: c.id, name: c.name, domain: c.domain, lifecycle: null }));
      if (sql.includes("crm_contacts")) return clients.filter((c) => c.kind === "contact").map((c) => ({ id: c.id, name: c.name, emails: [], lifecycle: null }));
      return [];
    },
  });
}

describe("clientsNamed", () => {
  it("matches a client company's name as written, as a hashtag or possessive, and its domain", () => {
    expect(clientsNamed(CLIENTS, ["Velox kids can count to it. #Velox"]).map((c) => c.id)).toEqual(["v1", "v2"]);
    expect(clientsNamed(CLIENTS, ["Lumen's reader"]).map((c) => c.id)).toEqual(["l1"]);
    expect(clientsNamed(CLIENTS, ["Try it at https://www.VeloxMath.com/start"]).map((c) => c.id)).toEqual(["v1"]);
  });

  it("ignores other casing, longer words and contacts (people's names)", () => {
    expect(clientsNamed(CLIENTS, ["we mend things", "Veloxity", "velox", "Sam Smith said hi"])).toEqual([]);
  });

  it("reads per-platform override text", () => {
    expect(overrideTexts({ x: { text: "#Velox" }, youtube: { title: "t", tags: ["a"] } })).toEqual(["#Velox", "t"]);
  });
});

describe("assertClientFiling", () => {
  const ctx = ctxWith(CLIENTS);

  it("refuses own work that names a client, and names the client to pass (domain row first)", async () => {
    const error = await assertClientFiling(ctx, "co", { texts: ["Velox kids can count. #Velox"], scope: null }).catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("your company's own post");
    expect((error as Error).message).toMatch(/Velox \(veloxmath\.com\): client "company:v1"; Velox: client "company:v2"/);
  });

  it("refuses a personal draft that names a client", async () => {
    await expect(assertClientFiling(ctx, "co", { texts: ["Lumen Read: one word at a time"], scope: null, personal: true })).rejects.toThrow(/personal My Social draft/);
  });

  it("refuses a post filed under the wrong client", async () => {
    await expect(assertClientFiling(ctx, "co", { texts: ["Lumen Read"], scope: { kind: "company", id: "v1" } })).rejects.toThrow(/another client's post/);
  });

  it("allows the client's own post, either CRM row of a duplicated name, text with no client, and on-purpose mentions", async () => {
    await assertClientFiling(ctx, "co", { texts: ["#Velox"], scope: { kind: "company", id: "v1" } });
    await assertClientFiling(ctx, "co", { texts: ["#Velox"], scope: { kind: "company", id: "v2" } });
    await assertClientFiling(ctx, "co", { texts: ["A demo is not a production workflow."], scope: null });
    await assertClientFiling(ctx, "co", { texts: ["We built Velox's sign-in."], scope: null, onPurpose: true });
  });
});

describe("own work never includes a person's My Social rows", () => {
  it("lists, destinations, metrics, summary and stats filter on scope = 'org'", async () => {
    const seen: string[] = [];
    const ctx = fakeCtx({}, { queryResult: (sql) => { seen.push(sql); return []; } });
    await db.listPosts(ctx, "co", { scope: null });
    await db.listPosts(ctx, "co", { scope: { kind: "company", id: "c1" } });
    await db.destinationsForScope(ctx, "co", null);
    await db.metricsForCompany(ctx, "co", null);
    await db.scopeSummary(ctx, "co", null);
    seen.push(statsQuery(ctx, "co", null).sql);
    expect(seen).toHaveLength(6);
    for (const sql of seen) expect(sql).toMatch(/scope = 'org'/);
    // Every subquery of the summary and the stats is filtered, not just the first.
    expect(seen[4]!.match(/scope = 'org'/g)).toHaveLength(5);
    expect(seen[5]!.match(/p\.scope = 'org'/g)).toHaveLength(3);
  });
});
