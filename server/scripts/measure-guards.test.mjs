import { describe, expect, it } from "vitest";
import {
  assertDisposableLoopbackDatabase,
  assertSafeServerUrl,
  sameRowsInOrder,
} from "./lib/measure-guards.mjs";

describe("assertDisposableLoopbackDatabase", () => {
  it("accepts a loopback database named as disposable", () => {
    expect(assertDisposableLoopbackDatabase("postgres://u:p@127.0.0.1:54329/paperclip_measure")).toContain("/paperclip_measure");
    expect(assertDisposableLoopbackDatabase("postgres://u:p@localhost/measure_before")).toContain("/measure_before");
  });

  it("refuses a host or hostaddr override, which postgres.js prefers over the url host", () => {
    expect(() => assertDisposableLoopbackDatabase("postgres://u:p@127.0.0.1:54329/paperclip_measure?host=remote.example")).toThrow(/query string/);
    expect(() => assertDisposableLoopbackDatabase("postgres://u:p@127.0.0.1:54329/paperclip_measure?hostaddr=10.0.0.5")).toThrow(/query string/);
    expect(() => assertDisposableLoopbackDatabase("postgres://u:p@127.0.0.1:54329/paperclip_measure?sslmode=disable")).toThrow(/query string/);
  });

  it("refuses a non-loopback host", () => {
    expect(() => assertDisposableLoopbackDatabase("postgres://u:p@db.example.com/paperclip_measure")).toThrow(/loopback/);
  });

  it("needs an explicit confirm for a database not named as disposable", () => {
    const url = "postgres://u:p@127.0.0.1:54329/paperclip";
    expect(() => assertDisposableLoopbackDatabase(url)).toThrow(/--confirm-database=paperclip/);
    expect(() => assertDisposableLoopbackDatabase(url, { confirmDatabase: "other" })).toThrow(/--confirm-database/);
    expect(assertDisposableLoopbackDatabase(url, { confirmDatabase: "paperclip" })).toContain("/paperclip");
  });

  it("refuses a missing or non-postgres url", () => {
    expect(() => assertDisposableLoopbackDatabase(undefined)).toThrow(/--database-url/);
    expect(() => assertDisposableLoopbackDatabase("http://127.0.0.1/paperclip_measure")).toThrow(/postgres/);
  });
});

describe("assertSafeServerUrl", () => {
  it("allows https anywhere and http only to loopback", () => {
    expect(assertSafeServerUrl("https://paperclip.example.com", "--after")).toBe("https://paperclip.example.com");
    expect(assertSafeServerUrl("http://127.0.0.1:3241", "--after")).toBe("http://127.0.0.1:3241");
  });

  it("refuses plain http to a remote host and credentials in the url", () => {
    expect(() => assertSafeServerUrl("http://paperclip.example.com", "--before")).toThrow(/https/);
    expect(() => assertSafeServerUrl("https://u:p@paperclip.example.com", "--before")).toThrow(/credentials/);
  });
});

describe("sameRowsInOrder", () => {
  it("compares ids and order", () => {
    expect(sameRowsInOrder(["a", "b"], ["a", "b"])).toBe(true);
    expect(sameRowsInOrder(["a", "b"], ["b", "a"])).toBe(false);
    expect(sameRowsInOrder(["a"], ["a", "b"])).toBe(false);
  });
});
