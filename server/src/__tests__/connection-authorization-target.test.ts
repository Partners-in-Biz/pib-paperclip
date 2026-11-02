import { describe, expect, it } from "vitest";
import {
  assertValidConnectionAuthorizationPayload,
  connectionAuthorizationTargetKey,
} from "../services/connection-authorization-target.js";

describe("connectionAuthorizationTargetKey", () => {
  it("keeps the readable key when it fits in 120 chars", () => {
    expect(connectionAuthorizationTargetKey("conn-1", "user-1")).toBe(
      "connection:conn-1:user:user-1",
    );
  });

  it("derives a stable key of at most 120 chars for a gallery uid that would overflow", () => {
    const uid = `app-gallery:google-drive:${"a1b2c3d4-0000-4000-8000-000000000000"}/google-drive-5b71c7b0`;
    const userId = "BjxhmUDCHf1zm0yaWpzTJBCpNVGpy6Ji";
    expect(`connection:${uid}:user:${userId}`.length).toBeGreaterThan(120);
    const key = connectionAuthorizationTargetKey(uid, userId);
    expect(key.length).toBeLessThanOrEqual(120);
    expect(connectionAuthorizationTargetKey(uid, userId)).toBe(key);
    expect(connectionAuthorizationTargetKey(uid, "someone-else")).not.toBe(key);
  });
});

describe("assertValidConnectionAuthorizationPayload", () => {
  it("rejects a payload whose target key is over 120 chars", () => {
    expect(() =>
      assertValidConnectionAuthorizationPayload({
        version: 1,
        prompt: "Connect",
        target: { type: "custom", key: "k".repeat(132) },
      }),
    ).toThrow();
  });
});
