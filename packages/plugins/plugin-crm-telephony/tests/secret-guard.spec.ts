import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { TELEPHONY_SECRET_NAMES } from "../src/secret-names.js";

const PLUGIN_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");

function walk(dir: string, excl = new Set<string>()): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (!excl.has(e.name)) {
      const p = join(dir, e.name);
      out.push(...(e.isDirectory() ? walk(p, excl) : [p]));
    }
  }
  return out;
}

const allText = walk(PLUGIN_ROOT, new Set(["node_modules", "dist", "secret-guard.spec.ts"])).map((f) => readFileSync(f, "utf8")).join("\n");
const srcText = readdirSync(join(PLUGIN_ROOT, "src")).filter((f) => f.endsWith(".ts") && f !== "secret-names.ts").map((f) => readFileSync(join(PLUGIN_ROOT, "src", f), "utf8")).join("\n");

describe("secret-guard", () => {
  it.each([
    new RegExp(`\\b${"hun"}${"t"}\\b`, "i"),
    new RegExp(`\\b${"hun"}${"t"}\\s*${"and"}`, "i"),
    new RegExp(`\\b${"hun"}${"t"}\\s*&\\s*${"and"}`, "i"),
    new RegExp(`\\b${"hun"}${"t"}\\s*&\\s*${"n"}`, "i"),
    new RegExp(`\\b${"hun"}${"t"}_${"and"}${"gun"}\\b`, "i"),
  ])("no tenant variants: pattern %#", (pattern) => {
    expect(allText).not.toMatch(pattern);
  });

  it("no Twilio SIDs", () => {
    expect(allText).not.toMatch(/\b(AC|SK)[0-9a-fA-F]{32}\b/);
  });

  it("src: no process.env", () => {
    expect(srcText).not.toMatch(/process\.env/);
  });

  it("src: tokens in allowlist", () => {
    const tokens = new Set<string>();
    for (const m of srcText.matchAll(/\b(TWILIO|DEEPGRAM|SMS_PROVIDER|TEL|R2)_[A-Z0-9_]{3,}\b/g)) {
      tokens.add(m[0]!);
    }
    const allowed = new Set(TELEPHONY_SECRET_NAMES);
    for (const t of tokens) {
      expect(allowed.has(t as never)).toBe(true);
    }
  });

  it("allowlist: pattern + no dupes", () => {
    const seen = new Set<string>();
    const pat = /^(TWILIO|DEEPGRAM|SMS_PROVIDER|TEL|R2)_[A-Z0-9_]{3,}$/;
    for (const name of TELEPHONY_SECRET_NAMES) {
      expect(pat.test(name) && !seen.has(name)).toBe(true);
      seen.add(name);
    }
  });

  it("positive: detects violation", () => {
    const vio: string[] = [];
    const allowed = new Set(TELEPHONY_SECRET_NAMES);
    for (const m of "TWILIO_FAKE_SECRET_NOT_ALLOWED".matchAll(/\b(TWILIO|DEEPGRAM|SMS_PROVIDER|TEL)_[A-Z0-9_]{3,}\b/g)) {
      if (!allowed.has(m[0] as never)) vio.push(m[0]!);
    }
    expect(vio).toEqual(["TWILIO_FAKE_SECRET_NOT_ALLOWED"]);
  });
});
