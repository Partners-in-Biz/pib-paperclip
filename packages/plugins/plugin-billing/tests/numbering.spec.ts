import { describe, expect, it } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { nextDocumentNumber } from "../src/numbering.js";

/** Minimal db fake: the counter holds n; the claim UPDATE bumps it. */
function fakeCtx(n: number): PluginContext {
  let counter = n;
  return {
    db: {
      namespace: "plugin_t",
      query: async (sql: string) => (sql.includes("numbering_counters") ? [{ n: counter }] : []),
      execute: async (sql: string) => {
        if (sql.includes("UPDATE")) counter += 1;
        return { rowCount: 1 };
      },
    },
  } as unknown as PluginContext;
}

const seq = (digits?: number) => ({ numbering: { mode: "sequential", ...(digits ? { digits } : {}) } }) as any;

describe("sequential numbering strings", () => {
  it("prints invoices with the digits setting", async () => {
    expect(await nextDocumentNumber(fakeCtx(179), "c", "invoice", null, seq())).toBe("INV-180");
    expect(await nextDocumentNumber(fakeCtx(999), "c", "invoice", null, seq())).toBe("INV-1000");
    expect(await nextDocumentNumber(fakeCtx(179), "c", "invoice", null, seq(4))).toBe("INV-0180");
  });

  it("keeps quotes and credit notes at four digits", async () => {
    expect(await nextDocumentNumber(fakeCtx(6), "c", "quote", null, seq())).toBe("QTE-0007");
    expect(await nextDocumentNumber(fakeCtx(6), "c", "credit_note", null, seq())).toBe("CN-0007");
  });
});
