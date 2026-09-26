import { buildKeyring, sealJson } from "@partnersinbiz/pib-plugin-kit";
import { loadMailboxConfig } from "../../src/config.js";
import { triageRunFor } from "../../src/gmail/sync.js";
import { FakeGmail } from "./fake-gmail.js";
import { CO, ENCRYPTION_KEY, fakeHost, MemoryStore, testEnv } from "./memory.js";

export function sealedTokens(overrides: Partial<{ accessToken: string; refreshToken: string | null; expiresAt: number }> = {}): string {
  const keyring = buildKeyring({ purpose: "mailbox-gmail", companyId: CO, secret: ENCRYPTION_KEY });
  return sealJson(
    {
      accessToken: "access-1",
      refreshToken: "refresh-1",
      expiresAt: Date.now() + 3_600_000,
      scope: "https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/gmail.send",
      ...overrides,
    },
    keyring,
  );
}

export function setup(config: Record<string, unknown> = {}) {
  const host = fakeHost(config);
  const store = new MemoryStore();
  const gmail = new FakeGmail();
  const env = testEnv(host, store, gmail.fetch, gmail.fetch as unknown as typeof fetch);
  const account = store.addAccount({ id: "acc-1", company_id: CO, address: gmail.email, token_sealed: sealedTokens(), is_default: true });
  const loaded = () => loadMailboxConfig(host.ctx, CO);
  const run = async () => triageRunFor(env, await loaded());
  return { host, store, gmail, env, account, loaded, run };
}

export const JEV_CONFIG = { jev: { apiKey: "jev-key", model: "jev-1.13.0", enabled: true } };
