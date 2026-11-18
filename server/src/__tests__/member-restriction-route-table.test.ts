import { describe, expect, it } from "vitest";
import {
  MEMBER_RESTRICTION_ROUTE_TABLE,
  createRouteClassifier,
  isUnsafeRestrictedPath,
  type MemberRestrictionRouteEntry,
} from "../services/member-restriction/route-table.js";

// PAR-12608 4.6, "Matching the way Express matches" (AC-G11).

const FIXTURE: MemberRestrictionRouteEntry[] = [
  { method: "GET", path: "/api/issues/:id", class: "open", test: "fixture" },
  { method: "POST", path: "/api/issues/:id/comments", class: "open", test: "fixture" },
  { method: "GET", path: "/api/agents/me", class: "run", test: "fixture" },
  { method: "USE", path: "/api/plugins/:pluginId/api", class: "plugin" },
  { method: "GET", path: "/api/approvals/:id", class: "by-company", test: "fixture" },
  { method: "GET", path: "/api/companies/:companyId/dashboard", class: "closed" },
];

/** A concrete path for a pattern: each param gets a plain value. */
function samplePath(pattern: string) {
  return pattern.replace(/[:*]([A-Za-z0-9_]+)/g, "sample1");
}

/** The variants of 4.6: upper case, trailing slash, `HEAD`, `//`, `%2F`, plus a query. */
function variants(entry: MemberRestrictionRouteEntry) {
  const plain = samplePath(entry.path);
  const method: string = entry.method === "USE" ? "GET" : entry.method;
  const list = [
    { method, path: plain.toUpperCase() },
    { method, path: `${plain}/` },
    { method, path: `${plain}?companyId=other` },
    { method, path: plain.replace("/api/", "/api//") },
    { method, path: `${plain.slice(0, plain.lastIndexOf("/"))}//${plain.slice(plain.lastIndexOf("/") + 1)}` },
    { method, path: plain.replace("sample1", "sample1%2Fx") },
    { method, path: plain.replace("sample1", "sample1%2fx") },
    { method, path: `${plain}/%2e%2e` },
  ];
  if (method === "GET") list.push({ method: "HEAD", path: plain }, { method: "head", path: plain });
  return { plain: { method, path: plain }, list };
}

async function assertVariantsHold(entries: readonly MemberRestrictionRouteEntry[]) {
  const classify = createRouteClassifier(entries);
  for (const entry of entries) {
    const { plain, list } = variants(entry);
    const base = await classify(plain.method, plain.path);
    expect(base, `${entry.method} ${entry.path}`).toMatchObject({ kind: "matched", entry });
    for (const variant of list) {
      const result = await classify(variant.method, variant.path);
      const sameOrRefused = result.kind === "refused" || (result.kind === "matched" && result.entry === entry);
      expect(sameOrRefused, `${variant.method} ${variant.path} -> ${JSON.stringify(result)}`).toBe(true);
    }
  }
}

describe("member restriction route table matcher", () => {
  it("every non-closed row of the real table survives the variant test (AC-G11)", async () => {
    await assertVariantsHold(MEMBER_RESTRICTION_ROUTE_TABLE);
  });

  it("the variant test holds on a fixture table of every class", async () => {
    await assertVariantsHold(FIXTURE);
  });

  it("matches the way Express matches", async () => {
    const classify = createRouteClassifier(FIXTURE);
    expect(await classify("GET", "/API/Issues/abc/")).toMatchObject({ kind: "matched", params: { id: "abc" } });
    expect(await classify("HEAD", "/api/issues/abc?x=1")).toMatchObject({ kind: "matched", entry: FIXTURE[0] });
    expect(await classify("GET", "/api/issues/a%20b")).toMatchObject({ params: { id: "a b" } });
    expect(await classify("POST", "/api/plugins/p1/api/deep/path")).toMatchObject({ entry: FIXTURE[3] });
    expect(await classify("DELETE", "/api/plugins/p1/api")).toMatchObject({ entry: FIXTURE[3] });
  });

  it("an unlisted route or a wrong method is unlisted, so closed", async () => {
    const classify = createRouteClassifier(FIXTURE);
    expect(await classify("DELETE", "/api/issues/abc")).toEqual({ kind: "unlisted" });
    expect(await classify("GET", "/api/issues/abc/extra")).toEqual({ kind: "unlisted" });
    expect(await classify("GET", "/api/issuesx/abc")).toEqual({ kind: "unlisted" });
    expect(await classify("OPTIONS", "/api/issues/abc")).toEqual({ kind: "unlisted" });
    expect(await createRouteClassifier([])("GET", "/api/issues/abc")).toEqual({ kind: "unlisted" });
    expect(await createRouteClassifier()("GET", "/api/no-such-route/abc")).toEqual({ kind: "unlisted" });
  });

  it("one request, several rows: closed wins, different classes refuse, one class agrees", async () => {
    const me = FIXTURE[2]!;
    const byId = { method: "GET", path: "/api/agents/:id", class: "open", test: "fixture" } as const;
    expect(await createRouteClassifier([me, byId])("GET", "/api/agents/me")).toEqual({ kind: "refused", reason: "ambiguous" });
    expect(await createRouteClassifier([{ ...me, class: "closed" }, byId])("GET", "/api/agents/me"))
      .toMatchObject({ kind: "matched", entry: { class: "closed" } });
    expect(await createRouteClassifier([{ ...me, class: "open" }, byId])("GET", "/api/agents/me"))
      .toMatchObject({ kind: "matched", entry: { class: "open" } });
    expect(await createRouteClassifier([me, byId])("GET", "/api/agents/a1")).toMatchObject({ entry: byId, params: { id: "a1" } });
  });

  it("shadows: the shadowing row answers its own path, the shadowed row the rest, and closed still wins", async () => {
    const me = { ...FIXTURE[2]!, shadows: "/api/agents/:id" };
    const byId = { method: "GET", path: "/api/agents/:id", class: "open", test: "fixture" } as const;
    const uuid = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const classify = createRouteClassifier([me, byId]);
    expect(await classify("GET", "/api/agents/me")).toMatchObject({ kind: "matched", entry: { path: "/api/agents/me", class: "run" } });
    expect(await classify("GET", `/api/agents/${uuid}`)).toMatchObject({ kind: "matched", entry: byId, params: { id: uuid } });
    expect(await createRouteClassifier([me, { ...byId, class: "closed" }])("GET", "/api/agents/me"))
      .toMatchObject({ kind: "matched", entry: { path: "/api/agents/:id", class: "closed" } });
    // A row of another method hides nothing.
    const mount = { method: "USE", path: "/api/agents/me", class: "plugin", shadows: "/api/agents/:id" } as const;
    expect(await createRouteClassifier([mount, byId])("GET", "/api/agents/me")).toEqual({ kind: "refused", reason: "ambiguous" });
  });

  it("refuses a param that does not decode", async () => {
    expect(await createRouteClassifier(FIXTURE)("GET", "/api/issues/%E0%A4%A")).toEqual({ kind: "refused", reason: "unroutable" });
  });

  it("refuses unsafe paths before the lookup", () => {
    for (const path of ["/api//issues", "/api/issues/a%2Fb", "/api/issues/a%2fb", "/api/issues/a%5Cb", "/api/issues/a\\b",
      "/api/./issues", "/api/issues/..", "/api/%2e%2E/x", "/api/.%2e/x", "/api/%2e/x"]) {
      expect(isUnsafeRestrictedPath(path), path).toBe(true);
    }
    for (const path of ["/api/issues/abc", "/api/issues/a.b", "/api/issues/v1.2/x", "/api/issues/...", "/api"]) {
      expect(isUnsafeRestrictedPath(path), path).toBe(false);
    }
  });
});
