/**
 * Cross-plugin contract: the CRM's `deal.accepted` hand-off carries exactly the fields of the kit's `DealAccepted`, and goes out under the
 * kit's event name. The CRM is the sender; Billing (or anything else) reads the kit type, so a field added or dropped on one side only is
 * caught here instead of in a receiver that quietly reads `undefined`.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEAL_ACCEPTED_FIELDS, HANDOFF_EVENTS } from "../src/index.js";

const source = readFileSync(fileURLToPath(new URL("../../plugin-crm/src/esign.ts", import.meta.url)), "utf8");

/** The keys of an object literal written as `{ a: x, b, c: y(1, 2) }`: split at the top level only. */
function literalKeys(literal: string): string[] {
  const keys: string[] = [];
  let depth = 0;
  let current = "";
  const flush = () => {
    const key = /^\s*([A-Za-z_$][\w$]*)\s*(?::|$)/.exec(current)?.[1];
    if (key) keys.push(key);
    current = "";
  };
  for (const char of literal) {
    if ("({[".includes(char)) depth += 1;
    if (")}]".includes(char)) depth -= 1;
    if (char === "," && depth === 0) flush();
    else current += char;
  }
  flush();
  return keys;
}

describe("CRM deal.accepted", () => {
  it("is sent under the kit's event name", () => {
    expect(source).toMatch(new RegExp(`DEAL_ACCEPTED_EVENT\\s*=\\s*"${HANDOFF_EVENTS.dealAccepted.replace(/\./g, "\\.")}"`));
  });

  it("carries the kit type's fields and no others", () => {
    const base = /const base = \{([^]*?)\};\s*\n\s*await sendHandoff\(ctx, doc\.companyId, DEAL_ACCEPTED_EVENT, \{ key:/.exec(source)?.[1];
    expect(base, "the CRM's hand-off object moved: update this contract test with it").toBeTruthy();
    // `key` is added next to `...base` in the call.
    expect(["key", ...literalKeys(base!)].sort()).toEqual([...DEAL_ACCEPTED_FIELDS].sort());
  });
});
