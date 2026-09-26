import { describe, expect, it } from "vitest";
import {
  clientScopeFromInput,
  clientScopeFromSearch,
  clientWhere,
  formatClientParam,
  parseClientParam,
  sameClient,
  scopeOfRow,
  withClientParam,
} from "../src/client-ref.js";

describe("client-ref", () => {
  it("parses and formats the URL form", () => {
    expect(parseClientParam("company:abc-123")).toEqual({ kind: "company", id: "abc-123" });
    expect(parseClientParam("contact:x_1")).toEqual({ kind: "contact", id: "x_1" });
    expect(parseClientParam("deal:1")).toBeNull();
    expect(parseClientParam("company:")).toBeNull();
    expect(parseClientParam("company:a/b")).toBeNull();
    expect(parseClientParam(null)).toBeNull();
    expect(formatClientParam({ kind: "contact", id: "c1" })).toBe("contact:c1");
    expect(clientScopeFromSearch("?tab=posts&client=company%3Aabc")).toEqual({ kind: "company", id: "abc" });
    expect(clientScopeFromSearch("")).toBeNull();
  });

  it("adds, replaces and removes the client param", () => {
    expect(withClientParam("/social?tab=posts", { kind: "company", id: "a" })).toBe("/social?tab=posts&client=company%3Aa");
    expect(withClientParam("/social?client=company%3Aa&tab=x", { kind: "contact", id: "b" })).toBe("/social?client=contact%3Ab&tab=x");
    expect(withClientParam("/social?client=company%3Aa&tab=x", null)).toBe("/social?tab=x");
    expect(withClientParam("/seo#top", null)).toBe("/seo#top");
  });

  it("reads tool and action input", () => {
    expect(clientScopeFromInput({ client: null })).toBeNull();
    expect(clientScopeFromInput({ client: "contact:c1" })).toEqual({ kind: "contact", id: "c1" });
    expect(clientScopeFromInput({ client: { kind: "company", id: "a" } })).toEqual({ kind: "company", id: "a" });
    expect(clientScopeFromInput({ clientRef: "a" })).toEqual({ kind: "company", id: "a" });
    expect(clientScopeFromInput({ clientRef: "a", clientKind: "contact" })).toEqual({ kind: "contact", id: "a" });
    expect(clientScopeFromInput({ clientRef: "" })).toBeNull();
    expect(clientScopeFromInput({})).toBeUndefined();
    expect(clientScopeFromInput({ client: "bogus" })).toBeUndefined();
  });

  it("builds SQL filters and compares scopes", () => {
    expect(clientWhere(null, 2)).toEqual({ sql: "client_ref IS NULL", params: [] });
    expect(clientWhere({ kind: "contact", id: "c" }, 2, "p")).toEqual({
      sql: "p.client_ref = $3 AND COALESCE(p.client_kind, 'company') = $2",
      params: ["contact", "c"],
    });
    expect(scopeOfRow({ client_ref: "a", client_kind: null })).toEqual({ kind: "company", id: "a" });
    expect(scopeOfRow({ client_ref: null })).toBeNull();
    expect(sameClient(null, null)).toBe(true);
    expect(sameClient({ kind: "company", id: "a" }, { kind: "contact", id: "a" })).toBe(false);
  });
});
