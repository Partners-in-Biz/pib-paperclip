import { describe, it, expect } from "vitest";
import { formatScopeKey, parseScopeKey, scopeFromClient } from "../src/index.js";

describe("growth-scope", () => {
  describe("roundtrip: own", () => {
    it("format then parse own", () => {
      const original = { type: "own" as const };
      const formatted = formatScopeKey(original);
      expect(formatted).toBe("own");
      const parsed = parseScopeKey(formatted);
      expect(parsed).toEqual(original);
    });

    it("parse then format own", () => {
      const raw = "own";
      const parsed = parseScopeKey(raw);
      expect(parsed).toEqual({ type: "own" });
      const formatted = formatScopeKey(parsed);
      expect(formatted).toBe(raw);
    });
  });

  describe("roundtrip: client:company:abc", () => {
    it("format then parse client:company:abc", () => {
      const original = { type: "client" as const, kind: "company" as const, ref: "abc" };
      const formatted = formatScopeKey(original);
      expect(formatted).toBe("client:company:abc");
      const parsed = parseScopeKey(formatted);
      expect(parsed).toEqual(original);
    });

    it("parse then format client:company:abc", () => {
      const raw = "client:company:abc";
      const parsed = parseScopeKey(raw);
      expect(parsed).toEqual({ type: "client", kind: "company", ref: "abc" });
      const formatted = formatScopeKey(parsed);
      expect(formatted).toBe(raw);
    });
  });

  describe("roundtrip: client:contact:x:y (ref with colon)", () => {
    it("format then parse client:contact:x:y", () => {
      const original = { type: "client" as const, kind: "contact" as const, ref: "x:y" };
      const formatted = formatScopeKey(original);
      expect(formatted).toBe("client:contact:x:y");
      const parsed = parseScopeKey(formatted);
      expect(parsed).toEqual(original);
    });

    it("parse then format client:contact:x:y", () => {
      const raw = "client:contact:x:y";
      const parsed = parseScopeKey(raw);
      expect(parsed).toEqual({ type: "client", kind: "contact", ref: "x:y" });
      const formatted = formatScopeKey(parsed);
      expect(formatted).toBe(raw);
    });
  });

  describe("roundtrip: product:p1", () => {
    it("format then parse product:p1", () => {
      const original = { type: "product" as const, projectId: "p1" };
      const formatted = formatScopeKey(original);
      expect(formatted).toBe("product:p1");
      const parsed = parseScopeKey(formatted);
      expect(parsed).toEqual(original);
    });

    it("parse then format product:p1", () => {
      const raw = "product:p1";
      const parsed = parseScopeKey(raw);
      expect(parsed).toEqual({ type: "product", projectId: "p1" });
      const formatted = formatScopeKey(parsed);
      expect(formatted).toBe(raw);
    });
  });

  describe("roundtrip: book:b1", () => {
    it("format then parse book:b1", () => {
      const original = { type: "book" as const, projectId: "b1" };
      const formatted = formatScopeKey(original);
      expect(formatted).toBe("book:b1");
      const parsed = parseScopeKey(formatted);
      expect(parsed).toEqual(original);
    });

    it("parse then format book:b1", () => {
      const raw = "book:b1";
      const parsed = parseScopeKey(raw);
      expect(parsed).toEqual({ type: "book", projectId: "b1" });
      const formatted = formatScopeKey(parsed);
      expect(formatted).toBe(raw);
    });
  });

  describe("malformed input", () => {
    it("throws on empty string", () => {
      expect(() => parseScopeKey("")).toThrow();
    });

    it("throws on unknown prefix", () => {
      expect(() => parseScopeKey("foo")).toThrow();
    });

    it("throws on own:x", () => {
      expect(() => parseScopeKey("own:x")).toThrow();
    });

    it("throws on client (missing kind and ref)", () => {
      expect(() => parseScopeKey("client")).toThrow();
    });

    it("throws on client:company (missing ref)", () => {
      expect(() => parseScopeKey("client:company")).toThrow();
    });

    it("throws on client:company: (empty ref)", () => {
      expect(() => parseScopeKey("client:company:")).toThrow();
    });

    it("throws on client:vendor:1 (invalid kind)", () => {
      expect(() => parseScopeKey("client:vendor:1")).toThrow();
    });

    it("throws on product (missing projectId)", () => {
      expect(() => parseScopeKey("product")).toThrow();
    });

    it("throws on product: (empty projectId)", () => {
      expect(() => parseScopeKey("product:")).toThrow();
    });

    it("throws on book: (empty projectId)", () => {
      expect(() => parseScopeKey("book:")).toThrow();
    });
  });

  describe("scopeFromClient", () => {
    it("converts null to own", () => {
      const result = scopeFromClient(null);
      expect(result).toEqual({ type: "own" });
    });

    it("converts undefined to own", () => {
      const result = scopeFromClient(undefined);
      expect(result).toEqual({ type: "own" });
    });

    it("converts company ref", () => {
      const result = scopeFromClient({ kind: "company", id: "c1" });
      expect(result).toEqual({ type: "client", kind: "company", ref: "c1" });
      expect(formatScopeKey(result)).toBe("client:company:c1");
    });

    it("converts contact ref", () => {
      const result = scopeFromClient({ kind: "contact", id: "ct1" });
      expect(result).toEqual({ type: "client", kind: "contact", ref: "ct1" });
      expect(formatScopeKey(result)).toBe("client:contact:ct1");
    });
  });
});
