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
 *
 * `prefer: marketing` (SES carries marketing only) decides per send on the `marketing` flag, see `pickMarketing`: everything that is not
 * marketing is picked as above (Gmail), and marketing never falls back to Gmail: a marketing send the provider cannot take FAILS.
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
  /** `failed`: the send cannot go out and must not go anywhere else; `problem` says why (permanent). */
  kind: "gmail" | "esp" | "failed";
  account: AccountRow | null;
  /** The provider's record of the account's domain (esp only). */
  domain: EspDomainRow | null;
  /** esp only: the Gmail address the request named, carried by this provider account (the From header keeps it). */
  fromAddress?: string;
  problem?: string;
}

const providerName = (provider: string) => (provider === "ses" ? "Amazon SES" : "the email provider");
const failure = (problem: string): PickedSender => ({ kind: "failed", account: null, domain: null, problem });

const gmailUsable = (account: AccountRow) => Boolean(account.token_sealed) && (account.status === "connected" || account.status === "needs_reconnect");

async function espPick(env: Pick<Env, "store">, account: AccountRow): Promise<PickedSender> {
  const domain = sendingDomain(account.address);
  return { kind: "esp", account, domain: domain ? await env.store.getEspDomain(account.company_id, domain) : null };
}

/** The company's own (not a client's) connected send-only accounts of `provider`, oldest first. */
const ownAccounts = (accounts: AccountRow[], provider: string) =>
  accounts.filter((account) => account.provider === provider && !account.client_ref && account.status === "connected").sort((a, b) => a.created_at.localeCompare(b.created_at));

/** `prefer: marketing`, for a send that is marketing. The caller has handled everything else. */
async function pickMarketing(env: Pick<Env, "store" | "ctx" | "now">, esp: LoadedConfig["config"]["esp"], companyId: string, request: Pick<MailSendRequested, "from" | "context">): Promise<PickedSender> {
  const name = providerName(esp.provider);
  const accounts = (await env.store.listAccounts(companyId)).filter((account) => account.provider === esp.provider && account.status !== "disconnected");
  // A client's marketing goes from the client's own account, as it does under every preference.
  const clientRef = request.context?.clientRef?.trim();
  if (clientRef) {
    const kind = request.context?.clientKind === "contact" ? "contact" : "company";
    const bound = accounts.find((account) => account.client_ref === clientRef && (account.client_kind ?? "company") === kind);
    if (bound) return espPick(env, bound);
  }
  const own = ownAccounts(accounts, esp.provider);
  if (request.from) {
    const email = toMailAddress(request.from)?.email;
    if (!email) return failure(`Not sent: "${request.from}" is not an email address.`);
    const named = await env.store.findAccountByAddress(companyId, email);
    if (named && isEspProvider(named.provider) && named.status !== "disconnected") {
      if (named.provider === esp.provider) return espPick(env, named);
      return failure(`Not sent: ${email} is a ${providerName(named.provider)} account, but this company sends marketing through ${name} (Mailbox settings, Email provider). Send from a ${name} address or one of the company's Gmail addresses on a domain ${name} has verified.`);
    }
    // A Gmail address: SES sends from any address on a domain it has verified, so the owner account on that domain carries it and the From header keeps the address.
    const domain = sendingDomain(email);
    if (!named || !gmailUsable(named) || !domain) return failure(`Not sent: no connected account for ${email} in the Mailbox.`);
    const carrier = own.find((account) => sendingDomain(account.address) === domain);
    const row = carrier ? (await espPick(env, carrier)).domain : null;
    if (!carrier || row?.status !== "verified") return failure(`Not sent: ${domain} is not verified at ${name}, so marketing from ${email} cannot go through it. Add and verify ${domain} (add-sending-domain); marketing is never sent from Gmail while marketing goes through ${name}.`);
    return { ...(await espPick(env, carrier)), fromAddress: email };
  }
  const chosen = (esp.defaultFrom ? own.find((account) => account.address.toLowerCase() === esp.defaultFrom) : null) ?? own[0] ?? null;
  if (!chosen) return failure(`Not sent: marketing goes through ${name} and the company has no connected ${name} sending account. Add one (add-sending-domain), or name a sender. It is not sent from Gmail.`);
  return espPick(env, chosen);
}

export async function pickSender(env: Pick<Env, "store" | "ctx" | "now">, loaded: LoadedConfig, companyId: string, request: Pick<MailSendRequested, "from" | "marketing" | "context">): Promise<PickedSender> {
  const prefer = loaded.config.esp.prefer;
  if (prefer === "marketing" && request.marketing === true) return pickMarketing(env, loaded.config.esp, companyId, request);
  if (request.from) {
    const email = toMailAddress(request.from)?.email;
    if (!email) return { kind: "gmail", account: null, domain: null };
    const account = await env.store.findAccountByAddress(companyId, email);
    if (account && isEspProvider(account.provider) && account.status !== "disconnected") {
      // Under `marketing` an SES account takes marketing only.
      if (prefer === "marketing" && account.provider === "ses") return failure(`Not sent: ${email} is an Amazon SES account, and SES carries marketing mail only. This message goes out from a Gmail account.`);
      return espPick(env, account);
    }
    return { kind: "gmail", account: account && gmailUsable(account) ? account : null, domain: null };
  }
  const esp = loaded.config.esp;
  // Without a provider switched on there is nothing to choose between: the default Gmail account, as always.
  if (esp.enabled && esp.hasCredentials) {
    const accounts = (await env.store.listAccounts(companyId)).filter((account) => account.provider === esp.provider && account.status !== "disconnected");
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
