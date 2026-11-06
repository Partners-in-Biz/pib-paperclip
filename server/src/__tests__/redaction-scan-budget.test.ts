import { randomBytes } from "node:crypto";
import { redactCommandText } from "@paperclipai/adapter-utils";
import { describe, expect, it } from "vitest";
import {
  MAX_EVENT_PAYLOAD_TEXT_CHARS,
  MAX_REDACTION_SCAN_CHARS,
  REDACTED_EVENT_VALUE,
  redactSensitiveText,
} from "../redaction.js";
import { validateToolContent } from "../services/tool-content-guards.js";

// PAR-8028: a large tool result froze the server's main thread inside
// redactSensitiveText. All data here is generated; none of it is a real secret.

function repeatTo(unit: string, length: number): string {
  return unit.repeat(Math.ceil(length / unit.length)).slice(0, length);
}

function fakeSecret(): string {
  return `gen-${randomBytes(12).toString("hex")}`;
}

function timed<T>(fn: () => T): { result: T; ms: number } {
  const start = performance.now();
  const result = fn();
  return { result, ms: performance.now() - start };
}

// Sizes are kept small enough that the old quadratic code fails these in
// seconds instead of hanging the test run (old: about 4s at 128K identifier
// run, 2.7s for 1M quote-newline text; new: under 50ms each). Vitest cannot
// interrupt synchronous code, so the budget is asserted after the call.
const BUDGET_MS = 750;

describe("redaction scan budget (PAR-8028)", () => {
  it("scans a long identifier run (base64url-like body) in linear time", () => {
    const input = repeatTo("tokenkey", 128 * 1024);
    const { result, ms } = timed(() => redactSensitiveText(input));
    expect(result).toBe(input);
    expect(ms).toBeLessThan(BUDGET_MS);
  });

  it("scans an identifier run with no secret word in linear time", () => {
    const input = `${repeatTo("Ab0_", 128 * 1024)}.`;
    const { result, ms } = timed(() => redactSensitiveText(input));
    expect(result).toBe(input);
    expect(ms).toBeLessThan(BUDGET_MS);
  });

  it("scans a base64url attachment body (dashes, secret-like words) in linear time", () => {
    // Gmail-style base64url: one long run with `-`, `--` and words such as
    // "key" or "jwt" appearing by chance. Old code: about 1s at 64K.
    const body = randomBytes(768 * 1024).toString("base64url");
    const input = `${body.slice(0, 128 * 1024)}-tokenKEYjwt--secret`;
    for (const fn of [redactSensitiveText, (s: string) => redactCommandText(s, "***")]) {
      const { result, ms } = timed(() => fn(input));
      expect(result).toBe(input);
      expect(ms).toBeLessThan(BUDGET_MS);
    }
  });

  it("keeps command redaction of flags, env assignments and JWTs", () => {
    const a = fakeSecret();
    const b = fakeSecret();
    const c = fakeSecret();
    const jwt = `${"eyJhbGciOi"}.${randomBytes(12).toString("base64url")}.${randomBytes(12).toString("base64url")}`;
    const out = redactCommandText(
      `run --api-key ${a} FOO="x MY_TOKEN=${b}" --client-secret="${c}" auth ${jwt}`,
      "***",
    );
    for (const secret of [a, b, c, jwt]) expect(out).not.toContain(secret);
    expect(out).toContain('--client-secret="***"');
  });

  it("scans quote-and-newline text after an Authorization word in linear time", () => {
    const input = `Authorization: "x${repeatTo('"\n', MAX_REDACTION_SCAN_CHARS - 20)}`;
    const { ms } = timed(() => redactSensitiveText(input));
    expect(ms).toBeLessThan(BUDGET_MS);
  });

  it("scans base64 and many-quotes text in linear time", () => {
    const base64 = randomBytes(768 * 1024).toString("base64").slice(0, MAX_REDACTION_SCAN_CHARS);
    const quotes = repeatTo('"a":"b", token: \'x\' ', MAX_REDACTION_SCAN_CHARS);
    for (const input of [base64, quotes]) {
      const { ms } = timed(() => redactSensitiveText(input));
      expect(ms).toBeLessThan(BUDGET_MS);
    }
  });

  it("still redacts secret fields in JSON, escaped JSON and auth headers", () => {
    const a = fakeSecret();
    const b = fakeSecret();
    const c = fakeSecret();
    const d = fakeSecret();
    const text = [
      `{"note": "ok", "client_api_key": "${a}"}`,
      JSON.stringify(JSON.stringify({ accessToken: b })),
      `proxyAuthorization: Bearer ${c}`,
      `{"label": "x", "password": "${d}"}`,
    ].join("\n");
    const redacted = redactSensitiveText(text);
    for (const secret of [a, b, c, d]) expect(redacted).not.toContain(secret);
    expect(redacted).toContain('"note": "ok"');
    expect(redacted).toContain('"label": "x"');
    expect(redacted).toContain(REDACTED_EVENT_VALUE);
  });

  it("finds a secret field that starts inside a non-secret field's value", () => {
    const secret = fakeSecret();
    const redacted = redactSensitiveText(`note: 'x', password: '${secret}'`);
    expect(redacted).not.toContain(secret);
  });

  it("withholds text too long to scan instead of passing it through", () => {
    const secret = fakeSecret();
    const input = `${repeatTo("lorem ipsum ", MAX_REDACTION_SCAN_CHARS)}"api_key": "${secret}"`;
    const { result, ms } = timed(() => redactSensitiveText(input));
    expect(result).not.toContain(secret);
    expect(result).toContain("Paperclip withheld this text");
    expect(result).toContain("file or signed link");
    expect(result.length).toBeLessThan(1000);
    expect(ms).toBeLessThan(50);
  });

  it("bounds a tool result with a huge inline attachment body", () => {
    const secret = fakeSecret();
    const body = `${randomBytes(3 * 1024 * 1024).toString("base64")}\n"password": "${secret}"`;
    const { result, ms } = timed(() =>
      validateToolContent({
        value: { filename: "statement.pdf", contentBase64: body, items: [body] },
        direction: "result",
        promptInjectionMode: "ignore",
      }),
    );
    const out = result.value as Record<string, unknown>;
    expect(ms).toBeLessThan(BUDGET_MS);
    expect(out.filename).toBe("statement.pdf");
    expect(out.contentBase64).toContain("Paperclip withheld this text");
    expect(String(out.contentBase64)).toContain(String(MAX_EVENT_PAYLOAD_TEXT_CHARS));
    expect(JSON.stringify(out)).not.toContain(secret);
    expect(result.summary.summary).not.toContain(secret);
    expect(result.findings).toContain("oversized_text_withheld");
  });

  it("leaves tool results under the limit untouched apart from redaction", () => {
    const secret = fakeSecret();
    const result = validateToolContent({
      value: { text: repeatTo("hello ", 10_000), apiKey: secret },
      direction: "result",
      promptInjectionMode: "ignore",
    });
    const out = result.value as Record<string, unknown>;
    expect(out.text).toBe(repeatTo("hello ", 10_000));
    expect(out.apiKey).toBe(REDACTED_EVENT_VALUE);
    expect(result.findings).not.toContain("oversized_text_withheld");
  });
});
