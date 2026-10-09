/**
 * Which account sends a request.
 *
 * - A request that names a sender (`from`) uses that account, whatever kind it is: a Gmail identity or a send-only
 *   account of the email provider. An address that is neither connected nor a provider account is not sent from (the
 *   request fails for good; it never falls back to the default).
 * - A request that names none goes out from the company's default Gmail account, exactly as before, with two exceptions
 *   that only exist once a provider account has been set up:
 *   - **a client's marketing** goes from the provider account that belongs to that client, when there is one: it is the
 *     client's own verified domain. It is never moved to another sender if that account cannot send right now: the send
 *     then fails with the reason, because a client's mail must not go out as somebody else.
 *   - **the company's transactional mail** (invoices, payslips, replies) goes from the company's own provider account
 *     when the owner chose `prefer: transactional`, and that account is connected. If it is not ready, Gmail takes it:
 *     the preference never holds an invoice back.
 */
import type { MailSendRequested } from "@partnersinbiz/pib-plugin-kit";
import { espReadiness, type LoadedConfig } from "./config.js";
import { sendingDomain } from "./dns.js";
import { holdsProviderSend, senderDomainHealth } from "./domain-health.js";
import { readEspState } from "./esp/runtime.js";
import { isEspProvider, type EspDomainRow } from "./esp/types.js";
import type { Env } from "./gmail/env.js";
import { toMailAddress } from "./gmail/headers.js";
import type { AccountRow } from "./gmail/types.js";

export interface PickedSender {
  kind: "gmail" | "esp";
  account: AccountRow | null;
  /** The provider's record of the account's domain (esp only). */
  domain: EspDomainRow | null;
}

const gmailUsable = (account: AccountRow) => Boolean(account.token_sealed) && (account.status === "connected" || account.status === "needs_reconnect");

async function espPick(env: Pick<Env, "store">, account: AccountRow): Promise<PickedSender> {
  const domain = sendingDomain(account.address);
  return { kind: "esp", account, domain: domain ? await env.store.getEspDomain(account.company_id, domain) : null };
}

export async function pickSender(env: Pick<Env, "store" | "ctx" | "now">, loaded: LoadedConfig, companyId: string, request: Pick<MailSendRequested, "from" | "marketing" | "context">): Promise<PickedSender> {
  if (request.from) {
    const email = toMailAddress(request.from)?.email;
    if (!email) return { kind: "gmail", account: null, domain: null };
    const account = await env.store.findAccountByAddress(companyId, email);
    if (account && isEspProvider(account.provider) && account.status !== "disconnected") return espPick(env, account);
    return { kind: "gmail", account: account && gmailUsable(account) ? account : null, domain: null };
  }
  const esp = loaded.config.esp;
  // Without a provider switched on there is nothing to choose between: the default Gmail account, as always.
  if (esp.enabled && esp.hasCredentials) {
    const accounts = (await env.store.listAccounts(companyId)).filter((account) => isEspProvider(account.provider) && account.status !== "disconnected");
    if (accounts.length > 0) {
      const clientRef = request.context?.clientRef?.trim();
      if (request.marketing === true && clientRef) {
        const kind = request.context?.clientKind === "contact" ? "contact" : "company";
        const bound = accounts.find((account) => account.client_ref === clientRef && (account.client_kind ?? "company") === kind);
        if (bound) return espPick(env, bound);
      } else if (request.marketing !== true && esp.prefer === "transactional") {
        const own = accounts.filter((account) => !account.client_ref && account.status === "connected").sort((a, b) => a.created_at.localeCompare(b.created_at));
        const chosen = (esp.defaultFrom ? own.find((account) => account.address.toLowerCase() === esp.defaultFrom) : null) ?? own[0] ?? null;
        if (chosen) {
          const picked = await espPick(env, chosen);
          // Only when the provider can take it right now: otherwise Gmail does, and the invoice is not held back.
          if (picked.domain?.status === "verified" && espReadiness(esp).sending && (await providerCanTake(env, companyId, chosen.address))) return picked;
        }
      }
    }
  }
  return { kind: "gmail", account: await env.store.defaultAccount(companyId), domain: null };
}

/** The provider is not refusing the key, is not out of quota, and the domain's mail authentication is not failing. */
async function providerCanTake(env: Pick<Env, "store" | "ctx" | "now">, companyId: string, address: string): Promise<boolean> {
  const state = await readEspState(env.ctx, companyId);
  if (state && !state.ok) return false;
  const health = await senderDomainHealth(env.store, companyId, address, env.now()).catch(() => null);
  return !(health?.known && health.problems.some((problem) => holdsProviderSend(problem, false)));
}
