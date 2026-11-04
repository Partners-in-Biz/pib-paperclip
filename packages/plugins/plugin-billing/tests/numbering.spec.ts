import { describe, expect, it } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { nextDocumentNumber, numberingSettings, sequenceNumbering } from "../src/numbering.js";

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

describe("numbering read-backs (PAR-7668)", () => {
  it("reads the settings with defaults: client mode, 3 digits, no fallback prefix", () => {
    expect(numberingSettings({} as any)).toEqual({ mode: "client", digits: 3, fallbackPrefix: null });
    expect(numberingSettings({ numbering: { mode: "sequential", digits: 4, fallbackPrefix: " PIB " } } as any)).toEqual({ mode: "sequential", digits: 4, fallbackPrefix: "PIB" });
    expect(numberingSettings({ numbering: { digits: 99 } } as any).digits).toBe(3);
  });

  it("gives the INV sequence as { mode, prefix, next, highestExisting } without writing", async () => {
    const ctx = fakeCtx(179);
    let writes = 0;
    (ctx.db as any).execute = async () => { writes += 1; return { rowCount: 1 }; };
    const out = await sequenceNumbering(ctx, "c", seq());
    expect(Object.keys(out).sort()).toEqual(["highestExisting", "mode", "next", "prefix"]);
    expect(out).toMatchObject({ mode: "sequential", prefix: "INV", next: 180 });
    expect(writes).toBe(0);
  });
});
