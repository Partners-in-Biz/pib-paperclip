import { describe, expect, it } from "vitest";
import { verifySharedSecret } from "../src/shared-secret.js";

type HeaderBag = Record<string, string | string[] | undefined>;

describe("Shared Secret", () => {
  it.each<[string, string | undefined, HeaderBag, boolean]>([
    ["correct", "mysecret", { "authorization": "mysecret" }, true],
    ["wrong", "mysecret", { "authorization": "wrongsecret" }, false],
    ["missing", "mysecret", {}, false],
    ["empty expected", "", { "authorization": "anything" }, false],
    ["undefined expected", undefined, { "authorization": "anything" }, false],
    ["Bearer prefix", "mysecret", { "authorization": "Bearer mysecret" }, true],
    ["Bearer lowercase", "mysecret", { "authorization": "bearer mysecret" }, true],
    ["different length", "short", { "authorization": "muchlongersecret" }, false],
    ["case-insensitive lookup", "mysecret", { "Authorization": "mysecret" }, true],
    ["header array", "mysecret", { "authorization": ["mysecret", "ignored"] }, true],
    ["trimmed value", "mysecret", { "authorization": "  mysecret  " }, true],
    ["Bearer wrong token", "mysecret", { "authorization": "Bearer wrongsecret" }, false],
  ])("%s", (_, expected, headers, result) => {
    expect(verifySharedSecret({ expected, headers, headerName: "authorization" })).toBe(result);
  });
});
