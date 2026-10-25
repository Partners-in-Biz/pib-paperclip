/**
 * PAR-5390: PayPal ships switched off. Until an owner ticks "Accept payments through PayPal" in a company's Billing
 * settings, no PayPal link is built, no PayPal call goes out and the setup list does not call it "on".
 */
import { describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import manifest from "../src/manifest.js";
import type { BillingSettings } from "../src/config.js";
import { buildProvider, enabledProviderKeys, providerState, providerStates } from "../src/pay/settings.js";

type Obj = Record<string, any>;

// A company that saved every PayPal secret and the public address but never switched PayPal on.
const secretRef = { type: "secret_ref", secretId: "00000000-0000-4000-8000-000000000001" };
const withSecrets = (paypal: Obj): BillingSettings =>
  ({
    payments: {
      publicBaseUrl: "https://paperclip.example",
      paypal: { clientId: secretRef, clientSecret: secretRef, webhookId: secretRef, ...paypal },
    },
  }) as unknown as BillingSettings;

// Any use of the context (secret resolve, http, db) fails the test.
function trippedCtx(): PluginContext {
  return new Proxy({}, { get: () => { throw new Error("context used while PayPal is off"); } }) as unknown as PluginContext;
}

describe("PayPal is off by default", () => {
  it("the manifest default is false, and the sandbox default is false", () => {
    const paypal = (manifest.instanceConfigSchema as Obj).properties.payments.properties.paypal.properties;
    expect(paypal.enabled.default).toBe(false);
    expect(paypal.sandbox.default).toBe(false);
  });

  it("a company with no settings, or only PayPal secrets saved, has PayPal off", () => {
    for (const settings of [{} as BillingSettings, withSecrets({}), withSecrets({ enabled: false }), withSecrets({ enabled: "true" as unknown as boolean })]) {
      expect(providerState(settings, "paypal")).toMatchObject({ key: "paypal", enabled: false, switchedOn: false, code: "off" });
      expect(enabledProviderKeys(settings)).not.toContain("paypal");
      expect(providerStates(settings).find((p) => p.key === "paypal")?.enabled).toBe(false);
    }
  });

  it("builds no provider and touches no secret, no http and no database while off", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      for (const settings of [{} as BillingSettings, withSecrets({}), withSecrets({ enabled: false })]) {
        await expect(buildProvider(trippedCtx(), "company-1", settings, "paypal")).resolves.toBeNull();
      }
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("switching it on is the only thing that makes it ready (and still needs the secrets and address)", () => {
    expect(providerState(withSecrets({ enabled: true }), "paypal")).toMatchObject({ enabled: true, switchedOn: true, code: "ok" });
    expect(providerState({ payments: { paypal: { enabled: true } } } as unknown as BillingSettings, "paypal")).toMatchObject({ enabled: false, switchedOn: true, code: "missing" });
  });
});
