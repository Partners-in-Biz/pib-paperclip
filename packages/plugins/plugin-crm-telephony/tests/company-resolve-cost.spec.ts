import { describe, expect, it } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { resolveVerifiedCompany } from "../src/company-resolve.js";
import { computeTwilioSignature } from "../src/twilio-signature.js";

function ctxWith(tokens: Record<string, string>) {
  const calls = { list: 0, resolve: 0 };
  const ctx = {
    companies: {
      list: async () => {
        calls.list++;
        return Object.keys(tokens).map((id) => ({ id }));
      },
    },
    secrets: {
      resolve: async (_n: string, o: { companyId: string }) => {
        calls.resolve++;
        return tokens[o.companyId];
      },
    },
  } as unknown as PluginContext;
  return { ctx, calls };
}

const url = "https://example.com/api/plugins/p/webhooks/w";
const body = "a=b";

describe("resolveVerifiedCompany: cost of unsigned hits", () => {
  it("rejects missing or malformed signatures without any lookup", async () => {
    const { ctx, calls } = ctxWith({ A: "tok-a", B: "tok-b" });
    for (const sig of [undefined, "", "not-base64!", "short="]) {
      const headers = sig === undefined ? {} : { "x-twilio-signature": sig };
      expect(await resolveVerifiedCompany(ctx, headers, body, url)).toEqual({ error: "bad_signature" });
    }
    expect(calls).toEqual({ list: 0, resolve: 0 });
  });

  it("reuses the company list and tokens across requests", async () => {
    const { ctx, calls } = ctxWith({ A: "tok-a", B: "tok-b" });
    const sig = computeTwilioSignature("tok-b", url, { a: ["b"] });
    for (let i = 0; i < 3; i++) {
      expect(await resolveVerifiedCompany(ctx, { "x-twilio-signature": sig }, body, url)).toEqual({ companyId: "B" });
    }
    const bad = computeTwilioSignature("other", url, { a: ["b"] });
    expect(await resolveVerifiedCompany(ctx, { "x-twilio-signature": bad }, body, url)).toEqual({ error: "bad_signature" });
    expect(calls).toEqual({ list: 1, resolve: 2 });
  });
});
