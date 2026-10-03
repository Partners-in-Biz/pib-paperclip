import { describe, expect, it } from "vitest";
import {
  CREDENTIAL_LIMITS,
  CredentialError,
  credentialBrief,
  credentialChecks,
  EXPIRY_BAD_DAYS,
  EXPIRY_WARN_DAYS,
  expiryOf,
  looksLikeSecret,
  parseCredentialInput,
  safeRotateHref,
  VERIFY_PROVIDERS,
  type CredentialRow,
} from "../src/credentials-model.js";
import { CREDENTIAL_SEED } from "../src/credentials-seed.js";

const NOW = new Date("2026-10-03T00:00:00.000Z");
const day = (n: number) => new Date(NOW.getTime() + n * 86_400_000).toISOString().slice(0, 10);

function row(over: Partial<CredentialRow> = {}): CredentialRow {
  return {
    id: "c1",
    companyId: "co",
    seedKey: null,
    name: "GitHub token",
    system: "GitHub",
    livesIn: "PAR company secret GITHUB_TOKEN",
    owner: "Owner",
    expiresAt: null,
    expiryNote: null,
    rotateHow: "Create a new fine-grained token",
    rotateHref: "https://github.com/settings/personal-access-tokens",
    verifyWith: "github",
    lastVerifiedAt: null,
    lastVerifyStatus: null,
    lastVerifyDetail: null,
    status: "active",
    notes: null,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    ...over,
  };
}

describe("what may be written into the register", () => {
  it("refuses anything that looks like a secret value, in any text field, and says what to do instead", () => {
    const secrets: Array<[string, string]> = [
      ["notes", "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8"],
      ["livesIn", "stored as sk-live-AbCdEfGhIjKlMnOpQrStUvWx"],
      ["rotateHow", "export GITHUB_TOKEN=abcd1234efgh5678"],
      ["notes", "password: hunter2hunter2"],
      ["expiryNote", "Bearer abcdefghijklmnop1234"],
      ["name", "https://user:pa55word@example.com/x"],
    ];
    for (const [field, value] of secrets) {
      let error: unknown;
      try {
        parseCredentialInput({ name: "A key", system: "X", [field]: value });
      } catch (e) {
        error = e;
      }
      expect(error, `${field}: ${value}`).toBeInstanceOf(CredentialError);
      expect((error as Error).message).toContain(`${field} looks like it holds a secret`);
      expect((error as Error).message).toContain("never the value itself");
      expect((error as Error).message).not.toContain(value); // the refusal does not repeat it
    }
  });

  it("accepts names and places, including the word secret or token on its own", () => {
    const input = parseCredentialInput({ name: "Resend API key", system: "Resend", livesIn: "PAR company secret RESEND_API_KEY", notes: "Used by the Mailbox plugin and the monitor", rotateHow: "Create a new key in the Resend dashboard" });
    expect(input).toMatchObject({ name: "Resend API key", system: "Resend", livesIn: "PAR company secret RESEND_API_KEY", id: null, markVerified: false });
    expect(looksLikeSecret("the token lives in the vault")).toBe(false);
    expect(looksLikeSecret("token=abc123abc123")).toBe(true);
  });

  it("a new credential needs a name and a system; an update needs only the id", () => {
    expect(() => parseCredentialInput({ system: "X" })).toThrow(/needs name and system/);
    expect(() => parseCredentialInput({ name: "X" })).toThrow(/needs name and system/);
    expect(parseCredentialInput({ id: "cred123", status: "retired" })).toMatchObject({ id: "cred123", status: "retired", name: null });
  });

  it("checks the date, the link, the provider and the status", () => {
    expect(() => parseCredentialInput({ name: "a", system: "b", expiresAt: "next year" })).toThrow(/YYYY-MM-DD/);
    expect(() => parseCredentialInput({ name: "a", system: "b", expiresAt: "2026-13-45" })).toThrow(/YYYY-MM-DD/);
    expect(parseCredentialInput({ name: "a", system: "b", expiresAt: "2027-02-01" }).expiresAt).toBe("2027-02-01");
    expect(parseCredentialInput({ id: "x", expiresAt: "" }).expiresAt).toBe("");
    expect(parseCredentialInput({ id: "x", expiresAt: "none" }).expiresAt).toBe("");
    expect(() => parseCredentialInput({ name: "a", system: "b", rotateHref: "javascript:alert(1)" })).toThrow(/rotateHref/);
    expect(() => parseCredentialInput({ name: "a", system: "b", rotateHref: "http://example.com" })).toThrow(/rotateHref/);
    expect(parseCredentialInput({ name: "a", system: "b", rotateHref: "/settings/secrets" }).rotateHref).toBe("/settings/secrets");
    expect(() => parseCredentialInput({ name: "a", system: "b", verifyWith: "stripe" })).toThrow(/verifyWith must be one of github, cloudflare, resend/);
    expect(parseCredentialInput({ id: "x", verifyWith: "none" }).verifyWith).toBe("none");
    expect(() => parseCredentialInput({ name: "a", system: "b", status: "lost" })).toThrow(/status must be active, retired or burned/);
  });

  it("trims and bounds the text", () => {
    const input = parseCredentialInput({ name: `  ${"n".repeat(400)}  `, system: " Sys\n tem ", notes: "x".repeat(900) });
    expect(input.name).toHaveLength(CREDENTIAL_LIMITS.name);
    expect(input.system).toBe("Sys tem");
    expect(input.notes).toHaveLength(CREDENTIAL_LIMITS.note);
  });

  it("rotate links: a Paperclip path or https, never a protocol-relative or script address", () => {
    expect(safeRotateHref("/cockpit")).toBe("/cockpit");
    expect(safeRotateHref("//evil.example")).toBeNull();
    expect(safeRotateHref("https://github.com/settings/tokens")).toBe("https://github.com/settings/tokens");
    expect(safeRotateHref("data:text/html,x")).toBeNull();
    expect(safeRotateHref("/a b")).toBeNull();
    expect(safeRotateHref("")).toBeNull();
  });
});

describe("expiry", () => {
  it("is quiet far out, warns at 30 days, goes red at 7 and when passed", () => {
    expect(expiryOf(row(), NOW)).toEqual({ state: "none", days: null });
    expect(expiryOf(row({ expiresAt: day(EXPIRY_WARN_DAYS + 1) }), NOW).state).toBe("ok");
    expect(expiryOf(row({ expiresAt: day(EXPIRY_WARN_DAYS) }), NOW)).toEqual({ state: "warn", days: 30 });
    expect(expiryOf(row({ expiresAt: day(EXPIRY_BAD_DAYS + 1) }), NOW).state).toBe("warn");
    expect(expiryOf(row({ expiresAt: day(EXPIRY_BAD_DAYS) }), NOW)).toEqual({ state: "bad", days: 7 });
    expect(expiryOf(row({ expiresAt: day(0) }), NOW).state).toBe("bad");
    expect(expiryOf(row({ expiresAt: day(-3) }), NOW)).toEqual({ state: "expired", days: -3 });
  });
});

describe("alerts", () => {
  it("one alert per credential that is close to its end, worded with the days and where to rotate", () => {
    const checks = credentialChecks([row({ id: "a", expiresAt: day(25) }), row({ id: "b", name: "Resend key", system: "Resend", expiresAt: day(5), rotateHref: null, rotateHow: null }), row({ id: "c", name: "Old", expiresAt: day(-2) }), row({ id: "d", expiresAt: day(200) })], NOW);
    expect(checks.map((c) => [c.key, c.status, c.title])).toEqual([
      ["credential:a:expiry", "warn", "GitHub token expires in 25 days"],
      ["credential:b:expiry", "bad", "Resend key expires in 5 days"],
      ["credential:c:expiry", "bad", "Old expired 2 days ago"],
    ]);
    expect(checks[0]!.fix).toContain("link: https://github.com/settings/personal-access-tokens");
    expect(checks[0]!.href).toBe("https://github.com/settings/personal-access-tokens");
    expect(checks[1]!.fix).toContain("Rotate it at the provider");
    expect(checks[1]!.href).toBe("/cockpit");
  });

  it("only a lapsed credential has a start of its own: an approaching expiry is aged from when it was first seen, never from its future date", () => {
    const [warn, bad, expired] = credentialChecks([row({ id: "a", expiresAt: day(25) }), row({ id: "b", expiresAt: day(5) }), row({ id: "c", expiresAt: day(-2) })], NOW);
    expect(warn!.since).toBeUndefined();
    expect(bad!.since).toBeUndefined();
    expect(expired!.since).toBe(day(-2));
  });

  it("a retired credential raises nothing; a refused one is red whatever its expiry; the burned ones are one warning", () => {
    expect(credentialChecks([row({ status: "retired", expiresAt: day(2), lastVerifyStatus: "invalid" })], NOW)).toEqual([]);
    const refused = credentialChecks([row({ lastVerifyStatus: "invalid", lastVerifyDetail: "GitHub refused it (expired or revoked).", lastVerifiedAt: NOW.toISOString() })], NOW);
    expect(refused).toHaveLength(1);
    expect(refused[0]).toMatchObject({ key: "credential:c1:invalid", status: "bad", title: "GitHub refused GitHub token" });
    const burned = credentialChecks([row({ id: "x", name: "Old token", status: "burned" }), row({ id: "y", name: "Other", status: "burned" })], NOW);
    expect(burned).toEqual([expect.objectContaining({ key: "credentials:burned", status: "warn", title: "2 credentials exposed and not yet replaced" })]);
    expect(burned[0]!.detail).toContain("Old token; Other");
  });

  it("an ok verdict and an unreachable provider raise nothing", () => {
    expect(credentialChecks([row({ lastVerifyStatus: "ok" }), row({ id: "z", lastVerifyStatus: "unreachable" })], NOW)).toEqual([]);
  });
});

describe("what the tool prints", () => {
  it("has no value, only names, places and the verdict", () => {
    const brief = credentialBrief(row({ expiresAt: day(12), lastVerifiedAt: NOW.toISOString(), lastVerifyStatus: "ok", lastVerifyDetail: "GitHub accepts it." }), NOW);
    expect(brief).toMatchObject({ id: "c1", expiry: "12 days left", expiresAt: day(12), lastVerify: "ok: GitHub accepts it.", verifyWith: "github" });
    expect(Object.keys(brief).sort()).toEqual(["expiresAt", "expiry", "id", "lastVerifiedAt", "lastVerify", "livesIn", "name", "notes", "owner", "rotate", "rotateHref", "status", "system", "verifyWith"]);
    expect(credentialBrief(row({ expiryNote: "Set when created" }), NOW).expiry).toBe("Set when created");
    expect(credentialBrief(row({ expiresAt: day(-4) }), NOW).expiry).toBe("expired 4 days ago");
  });
});

describe("the seed (the table in security.md)", () => {
  it("has the 22 credentials, once each, with names and places only", () => {
    expect(CREDENTIAL_SEED).toHaveLength(22);
    expect(new Set(CREDENTIAL_SEED.map((s) => s.seedKey)).size).toBe(22);
    for (const s of CREDENTIAL_SEED) {
      for (const [field, value] of Object.entries({ name: s.name, system: s.system, livesIn: s.livesIn, expiryNote: s.expiryNote ?? "", rotateHow: s.rotateHow, notes: s.notes ?? "" })) {
        // Text the register would refuse from an agent is not in the seed either. Only the word-colon pattern is excused: places are written as NAME: where.
        expect(/\b(?:github_pat_|gh[pousr]_)[A-Za-z0-9_]{16,}|\b(?:sk|pk|rk)[-_](?:live|test|ant|proj)?[-_]?[A-Za-z0-9_-]{16,}|\bAKIA[A-Z0-9]{16}\b|:\/\/[^\s/@:]+:[^\s/@]*@/.test(value), `${s.seedKey}.${field}`).toBe(false);
      }
      if (s.rotateHref) expect(safeRotateHref(s.rotateHref), s.seedKey).toBe(s.rotateHref);
      if (s.verifyWith) expect(VERIFY_PROVIDERS).toContain(s.verifyWith);
      if (s.expiresAt) expect(s.expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it("marks the credentials security.md says were exposed as burned, and nothing else", () => {
    const burned = CREDENTIAL_SEED.filter((s) => s.status === "burned").map((s) => s.seedKey).sort();
    expect(burned).toEqual(["claude-setup-token", "covalonic-vendor-keys", "github-classic-old", "github-fine-grained-v1"]);
  });

  it("names a check only where one exists: the agents' GitHub token, the R2 storage token and the Resend key", () => {
    expect(CREDENTIAL_SEED.filter((s) => s.verifyWith).map((s) => [s.seedKey, s.verifyWith])).toEqual([["github-fine-grained-new", "github"], ["r2-storage-token", "cloudflare"], ["resend-key", "resend"]]);
  });
});
