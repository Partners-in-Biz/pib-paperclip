import type { AccessGrant } from "@partnersinbiz/pib-plugin-kit";
import { describe, expect, it } from "vitest";
import { ACCESS_PART_MAX_BYTES, splitAccessPayload } from "../src/access-publish.js";

const STATE = { companyId: "co", rev: 7, mode: "report" as const };
const size = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
const grant = (userId: string, linked: number): AccessGrant => ({
  userId,
  preset: "clientManager",
  allow: [],
  deny: [],
  linkedCompanyIds: Array.from({ length: linked }, (_, i) => `company-${userId}-${i}`),
  scopeOverrides: {},
  updatedBy: "owner",
  updatedAt: "2026-11-17T10:00:00.000Z",
});
const grantsOf = (count: number, linked: number) => Object.fromEntries(Array.from({ length: count }, (_, i) => [`user-${i}`, grant(`user-${i}`, linked)]));

describe("splitAccessPayload", () => {
  it("sends a small state as one part", () => {
    const grants = grantsOf(3, 2);
    expect(splitAccessPayload(STATE, grants)).toEqual([{ ...STATE, userIds: ["user-0", "user-1", "user-2"], part: 1, parts: 1, grants }]);
  });

  it("sends an empty state as one part", () => {
    expect(splitAccessPayload(STATE, {})).toEqual([{ ...STATE, userIds: [], part: 1, parts: 1, grants: {} }]);
  });

  it("splits past 150,000 bytes: same rev, full userIds, every part within the limit, every grant once", () => {
    const grants = grantsOf(160, 150);
    expect(size({ ...STATE, grants })).toBeGreaterThan(ACCESS_PART_MAX_BYTES * 3);
    const parts = splitAccessPayload(STATE, grants);
    expect(parts.length).toBeGreaterThan(3);
    const seen: Record<string, AccessGrant> = {};
    parts.forEach((part, index) => {
      expect(size(part)).toBeLessThanOrEqual(ACCESS_PART_MAX_BYTES);
      expect(part).toMatchObject({ ...STATE, part: index + 1, parts: parts.length, userIds: Object.keys(grants) });
      for (const [id, g] of Object.entries(part.grants)) {
        expect(seen[id]).toBeUndefined();
        seen[id] = g;
      }
    });
    expect(seen).toEqual(grants);
  });

  it("keeps a payload exactly at the limit whole, and splits one byte over", () => {
    const grants = grantsOf(2, 1);
    const exact = size({ ...STATE, userIds: Object.keys(grants), part: 1, parts: 1, grants });
    expect(splitAccessPayload(STATE, grants, exact)).toHaveLength(1);
    expect(splitAccessPayload(STATE, grants, exact - 1)).toHaveLength(2);
  });

  it("sends a grant larger than a part alone in its part", () => {
    const grants = { small: grant("small", 1), big: grant("big", 400) };
    const parts = splitAccessPayload(STATE, grants, 2_000);
    expect(parts.map((part) => Object.keys(part.grants))).toEqual([["small"], ["big"]]);
  });
});
