/**
 * Sending a `mail.send.requested` through the email provider: the same request, the same `mail.send.result`, the same
 * rules around it as Gmail, and the rules a provider adds. In this order (the first that applies decides):
 *
 * 1. **It must be allowed to send at all.** The provider is on and complete (API key AND webhook signing secret),
 *    the sender is a connected send-only account whose domain the provider has verified, the request is for the
 *    account's client (a client's account sends only that client's mail), and the domain's mail authentication is not
 *    failing (`bad` SPF or DKIM at the provider's records holds every send back; a bad bounce or complaint record holds
 *    only marketing back). Each of these is a permanent failure with what to fix: the plugin that asked hands the mail
 *    to a person. It is never re-routed to Gmail: a client's mail must not go out as the company.
 *    **A client message keeps its links intact** (0.6.1): mail with `context.kind` `client_message` carries a private link (a signing link is a
 *    bearer token in the URL fragment), and tracking at the provider is a setting of the DOMAIN (the send call has no per-message switch)
 *    that rewrites links through the provider's own address. So before such a message is handed over the Mailbox reads the domain's two
 *    tracking flags from the provider; anything but both confirmed off is a permanent failure that says how to switch tracking off, or
 *    to send it from the client's Gmail mailbox. A read that failed defers the send (nothing was handed over).
 * 2. **The do-not-email list** (same code as Gmail, per sender): suppressed recipients are left out; nobody left is a
 *    permanent failure with the `suppressed` list.
 * 3. **Soft-bounce back-off** (marketing): an address that soft bounced lately waits (6, 24, then 72 hours). A message
 *    with nobody else to send to is deferred; the sender retries it.
 * 4. **An unsubscribe link** (marketing): a send-only address has no inbox to read an "unsubscribe" reply in, so marketing
 *    needs an https one-click link (the caller's, or the Mailbox's own once its proxy rule is proved). Without one it fails
 *    for good and says how to get one.
 * 5. **A blind retry is bounded**: a retry after an attempt that may have reached the provider (see below) is refused once its
 *    idempotency key is about to be forgotten.
 * 6. **The daily cap** (marketing): a new domain ramps up (`warmup.ts`); over the cap the send is deferred and retried. A marketing
 *    message with more recipients than the domain is ever handed in a day fails for good. Transactional mail is counted, never held back.
 * 7. **The request rate** to the provider (`limiter.ts`), then the call, with the request key as the idempotency key.
 *
 * Deferred means `throw`: nothing is stored and the sender's outbox asks again (for about three days). Two kinds of "not yet" are
 * different and are kept apart:
 * - **Not accepted** (the key was refused, the quota is used up, a rate limit, the provider is not ready): the provider did not take
 *   the message and holds no key for it, so it can be tried again whenever the cause is fixed, for the whole three days.
 * - **No answer** (a timeout, a 5xx): the provider MAY have taken it. It is retried with the same key, which the provider answers with
 *   the first result, for 20 hours counted from that first unanswered attempt (the provider remembers a key for 24). After that, or
 *   after a batch whose outcome is unknown, it is a permanent failure that says to look in the provider's log, because sending it
 *   again could deliver it twice. A later refusal or deferral says nothing about the unanswered attempt, so the mark stays on the
 *   send (`delivery.maybeAcceptedAt`) until the key changes.
 */
import { createHash } from "node:crypto";
import type { MailSendRequested } from "@partnersinbiz/pib-plugin-kit";
import { espReadiness, type LoadedConfig } from "../config.js";
import { sendingDomain } from "../dns.js";
import { holdsProviderSend, senderDomainHealth } from "../domain-health.js";
import { EspUnavailable, MailboxError, SendThrottled } from "../domain.js";
import { isPrivateMail } from "../private-mail.js";
import { errorMessage, type Env } from "../gmail/env.js";
import type { AccountRow, SendRecordInput, SendRow, SkippedRecipient } from "../gmail/types.js";
import { accountScopeProblem, accountSenderKey, cleanDisplayName, effectiveReplyTo } from "../sender.js";
import { AttachmentError, downloadAttachments, domainWarnings, failed, resultFromRow, type SendOptions, type SendResult } from "../send-shared.js";
import { checkSuppression } from "../suppression.js";
import { ownOneClickUrl } from "../unsubscribe.js";
import { tagValue } from "./resend.js";
import { espProviderFor, noteEspState, pauseEspLimiter } from "./runtime.js";
import { EspApiError, type EspAttachment, type EspDomainRow, type EspEmail } from "./types.js";
import { dailyCap, DAY_MS, highestDailyCap, utcDay, WARMUP_IDLE_RESET_DAYS } from "./warmup.js";

/** A retry of a call with an unknown outcome is safe while the provider still remembers the idempotency key (24 hours); stop a few hours before. */
export const ESP_RETRY_WINDOW_MS = 20 * 3_600_000;

/**
 * When the first attempt that MAY have reached the provider started (the moment its idempotency key began to be remembered), or null
 * when no attempt could have. Two things say so: the mark an attempt with no answer leaves on the send (`delivery.maybeAcceptedAt`),
 * and a claim that never settled (status `sending`: the worker died somewhere around the call). An attempt the provider refused or
 * deferred leaves neither, so a send that waited for a key or a quota is not mistaken for one that may have been delivered.
 */
export function maybeAcceptedAt(row: Pick<SendRow, "status" | "claimed_at" | "delivery"> | null): number | null {
  if (!row) return null;
  const unsettled = row.status === "sending" && row.claimed_at ? Date.parse(row.claimed_at) : Number.NaN;
  const times = [markedAt(row), unsettled].filter((time) => Number.isFinite(time));
  return times.length > 0 ? Math.min(...times) : null;
}

/** The mark an attempt with no answer leaves on the send, as a time (NaN when there is none or it was cleared). */
function markedAt(row: Pick<SendRow, "delivery">): number {
  return Date.parse(String((row.delivery as { maybeAcceptedAt?: unknown } | null | undefined)?.maybeAcceptedAt ?? ""));
}

/**
 * Most attachment bytes a message through the provider carries. They travel base64 encoded inside a JSON request that crosses the
 * host's worker channel, so a 25 MB Gmail attachment would become a 34 MB message. Real attachments here are invoices and payslips.
 */
export const ESP_MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;

export interface EspPick {
  account: AccountRow;
  domain: EspDomainRow | null;
  /** A Gmail address the request named, carried by this (SES owner) account: the From header is this address, the sending account stays `account`. */
  fromAddress?: string;
}

const recipientsOf = (request: Pick<MailSendRequested, "to" | "cc" | "bcc">) => [...request.to, ...(request.cc ?? []), ...(request.bcc ?? [])];

/** A From header the provider accepts, with the name quoted. */
export function formatFrom(name: string | null | undefined, address: string): string {
  const clean = cleanDisplayName(name);
  return clean ? `"${clean.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}" <${address}>` : address;
}

/**
 * The key the provider uses to recognise a repeat: the company and the request key, hashed (a key can be long and holds colons).
 * `generation` counts the answers that ended an attempt for good (a refused message, a domain the provider said was not
 * verified). A retry after one of those, by hand once the cause is fixed, gets a new key: the provider may remember the
 * first key together with its answer and would otherwise answer the same thing for 24 hours. Retries of a call that got no
 * answer keep the generation, so they keep the key, which is what makes them safe.
 */
export function idempotencyKeyFor(companyId: string, key: string, generation = 0): string {
  return `pib-${createHash("sha256").update(`${companyId}\n${key}${generation > 0 ? `\ng${generation}` : ""}`).digest("hex").slice(0, 48)}`;
}

/** How many definitive provider answers this request has had so far (kept in the send's `delivery` detail). */
export function generationOf(row: Pick<SendRow, "delivery"> | null): number {
  const gen = Number((row?.delivery as { gen?: unknown } | null | undefined)?.gen ?? 0);
  return Number.isInteger(gen) && gen > 0 ? gen : 0;
}

/**
 * The `pib_send` tag value: the send's key made tag-safe (letters, digits, underscore, dash), or a hash of it when it is too long for a tag.
 * An SES event names the send through it, so the same function is used wherever a tag is matched to a send.
 */
export function sendTagValue(key: string): string {
  return key.length <= 200 ? tagValue(key) : `h_${createHash("sha256").update(key).digest("hex").slice(0, 48)}`;
}

export function buildEspEmail(input: { companyId: string; account: Pick<AccountRow, "address" | "from_name" | "reply_to">; fromName: string | null; request: MailSendRequested; unsubscribeUrl: string | null; attachments: EspAttachment[]; generation?: number; /** Also tag the message with its send key (SES: an unknown outcome is reconciled by the later Send event). */ sendTag?: boolean }): { email: EspEmail; replyToMissing: boolean } {
  const { request, account } = input;
  const replyTo = effectiveReplyTo(request.replyTo, account.address)?.email ?? account.reply_to ?? null;
  const email: EspEmail = {
    from: formatFrom(request.fromName ?? account.from_name ?? input.fromName, account.address),
    to: request.to.map((a) => a.email),
    ...(request.cc?.length ? { cc: request.cc.map((a) => a.email) } : {}),
    ...(request.bcc?.length ? { bcc: request.bcc.map((a) => a.email) } : {}),
    subject: request.subject,
    html: request.html ?? null,
    text: request.text ?? null,
    replyTo,
    // RFC 8058: the https address and the Post header together. No mailto form: nobody reads the inbox of a send-only address.
    ...(request.marketing === true && input.unsubscribeUrl ? { headers: { "List-Unsubscribe": `<${input.unsubscribeUrl}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } } : {}),
    ...(input.attachments.length ? { attachments: input.attachments } : {}),
    tags: [{ name: "pib_company", value: tagValue(input.companyId) }, ...(input.sendTag ? [{ name: "pib_send", value: sendTagValue(request.key) }] : [])],
    idempotencyKey: idempotencyKeyFor(input.companyId, request.key, input.generation ?? 0),
  };
  return { email, replyToMissing: replyTo === null };
}

/** The words for where a person looks up a message the provider may have taken. */
const lookIn = (provider: string): string => (provider === "ses" ? "the SES console (Amazon SES, then Configuration sets and the account dashboard)" : "the provider's log (resend.com, Emails)");

/**
 * Marketing through a provider whose account is still in its sandbox (SES): refused before any call, so a person asks for production access
 * instead of watching sends fail on unverified recipients. null when the provider reports no limits or is out of the sandbox.
 */
async function sandboxProblem(env: Env, loaded: LoadedConfig, marketing: boolean): Promise<string | null> {
  if (!marketing) return null;
  const provider = await espProviderFor(env, loaded, { forSending: true });
  if (!provider.ok || !provider.quota || provider.quota.productionAccessEnabled) return null;
  return "SES is in the sandbox: 200 a day, 1 a second, verified recipients only; ask AWS for production access.";
}

/** The reasons this send cannot go out from this account at all (permanent), or null. */
async function notAllowed(env: Env, loaded: LoadedConfig, pick: EspPick, request: MailSendRequested): Promise<string | null> {
  const { account } = pick;
  const domain = sendingDomain(account.address) ?? account.address;
  const ready = espReadiness(loaded.config.esp);
  if (!ready.sending) return `Not sent: the email provider is not ready. ${ready.blockers.join(" ")}`;
  if (!pick.domain || pick.domain.status !== "verified" || account.status !== "connected") {
    return `Not sent: ${domain} is not verified at the email provider yet, so ${account.address} cannot send. Add the DNS records that list-sending-domains shows, then check the domain again (check-sender-domain).`;
  }
  const health = await senderDomainHealth(env.store, account.company_id, domain, env.now());
  if (health.known) {
    const marketing = request.marketing === true;
    // A bad DNS record of the provider's holds every send back; a bad bounce or complaint record holds only marketing back.
    const holding = health.problems.filter((problem) => holdsProviderSend(problem, marketing));
    if (holding.length > 0) return `Not sent from ${domain}: ${holding.map((problem) => problem.message).slice(0, 3).join(" ")} Fix it, run check-sender-domain, then retry the send from the Mailbox.`;
  }
  return null;
}

/**
 * For a client message: null when the provider says open and click tracking are both OFF for the sending domain, else why it may not go
 * out through this domain. Throws (the send is asked again later) when the provider could not be asked: nothing has been handed over.
 */
export async function trackingProblem(env: Env, loaded: LoadedConfig, pick: EspPick, request: Pick<MailSendRequested, "context">): Promise<string | null> {
  if (!isPrivateMail(request.context) || !pick.domain) return null;
  const domain = pick.domain.domain;
  const provider = await espProviderFor(env, loaded, { forSending: true });
  // A provider that is not ready is reported by the rules that follow, in their own words.
  if (!provider.ok) return null;
  let remote;
  try {
    remote = await provider.provider.getDomain(pick.domain.provider_domain_id);
  } catch (error) {
    if (error instanceof EspApiError && error.kind === "not_found") return `Not sent: ${domain} is not registered at the email provider any more, so it cannot send. Add it again (add-sending-domain).`;
    if (error instanceof EspApiError && error.kind === "config") await noteEspState(env.ctx, pick.domain.company_id, { code: "key_refused", detail: error.message }, env.now());
    throw new EspUnavailable(`The Mailbox could not check that tracking is off for ${domain} before sending a client message (${errorMessage(error)}); it is tried again.`);
  }
  // What the provider said is kept, so the page can show it before a message is refused.
  await env.store.patchEspDomain(pick.domain.company_id, domain, { open_tracking: remote.openTracking ?? null, click_tracking: remote.clickTracking ?? null }).catch(() => undefined);
  const on = [remote.clickTracking === true ? "click" : null, remote.openTracking === true ? "open" : null].filter((word): word is string => Boolean(word));
  const way = `Switch tracking off for ${domain} in the provider's dashboard (https://resend.com/domains, the domain, Configuration), or send this message from the client's Gmail mailbox.`;
  if (on.length > 0) {
    return `Not sent: ${on.join(" and ")} tracking is switched on for ${domain} at the email provider. A client message carries a private link (a signing link, a report); click tracking rewrites links through the provider's own address, which would break the link and show it to the provider, and an open pixel reports who read it. ${way}`;
  }
  if (remote.clickTracking !== false || remote.openTracking !== false) {
    return `Not sent: the email provider did not say whether open and click tracking are off for ${domain}, and a client message must not go through a domain that may rewrite its links. ${way} Then check the domain again (check-sender-domain).`;
  }
  return null;
}

/** Sends one request through the provider. See the file header for the order of the rules. Throws when it should be asked again later. */
export async function performEspSend(env: Env, loaded: LoadedConfig, pick: EspPick, request: MailSendRequested, options: SendOptions, before: SendRow | null, problem: string | null): Promise<SendResult> {
  const { account } = pick;
  const companyId = account.company_id;
  const now = env.now();
  const marketing = request.marketing === true;
  const domainName = sendingDomain(account.address) ?? "";
  const senderKey = accountSenderKey(account);
  const record: SendRecordInput = {
    key: request.key,
    companyId,
    sourcePlugin: options.sourcePlugin,
    accountId: account.id,
    fromAddress: account.address,
    to: request.to,
    subject: request.subject,
    context: request.context,
    request,
  };
  const fail = async (message: string, skipped: SkippedRecipient[] = []): Promise<SendResult> => {
    await env.store.recordSendFailure(record, message, true, skipped);
    return failed(request, message, skipped);
  };

  // 1. Allowed to send at all.
  const early = problem ?? accountScopeProblem(account, request) ?? (await notAllowed(env, loaded, pick, request)) ?? (await trackingProblem(env, loaded, pick, request)) ?? (await sandboxProblem(env, loaded, marketing));
  if (early) return fail(early);

  // 2. The do-not-email list.
  const check = await checkSuppression(env.store, companyId, request, senderKey);
  if (check.blocked) return fail(check.error ?? "Not sent: every recipient is on the do-not-email list.", check.skipped);
  let outgoing: MailSendRequested = check.request;
  const skipped = check.skipped;
  const warnings: string[] = [];

  // 3. Soft-bounce back-off (marketing only: an invoice is still worth another try).
  if (marketing) {
    const waiting = (await env.store.recipientHealth(companyId, recipientsOf(outgoing).map((a) => a.email))).filter((row) => row.backoff_until && Date.parse(row.backoff_until) > now);
    if (waiting.length > 0) {
      const wait = new Set(waiting.map((row) => row.email));
      const keep = (list: MailSendRequested["to"] | undefined) => (list ?? []).filter((a) => !wait.has(a.email.toLowerCase()));
      const left = { ...outgoing, to: keep(outgoing.to), cc: keep(outgoing.cc), bcc: keep(outgoing.bcc) };
      if (recipientsOf(left).length === 0) {
        const until = waiting.map((row) => row.backoff_until!).sort().at(-1)!;
        throw new SendThrottled(`Marketing mail to ${waiting.map((row) => row.email).join(", ")} waits until ${until} after a soft bounce; it is tried again then`);
      }
      outgoing = left;
      warnings.push(`Left out for now after a soft bounce (marketing mail waits 6 to 72 hours): ${waiting.map((row) => row.email).join(", ")}.`);
    }
  }

  // 4. An unsubscribe link, for marketing: the caller's, else the Mailbox's own once its proxy rule is proved.
  let unsubscribeUrl: string | null = null;
  if (marketing) {
    unsubscribeUrl = outgoing.unsubscribeUrl ?? (await ownOneClickUrl(env, loaded, outgoing, companyId, senderKey));
    if (!unsubscribeUrl) {
      return fail("Not sent: marketing mail through the email provider needs an https one-click unsubscribe link, because nobody reads the inbox of a send-only address and an \"unsubscribe\" reply would be lost. The request carried none, and the Mailbox can make its own only for a single recipient with the unsubscribe secret saved and the reverse-proxy rule proved (see Setup, one-click unsubscribe). Campaigns supplies its own link when its unsubscribe page is set up.", skipped);
    }
  }

  // 5. A retry after an attempt that MAY have reached the provider is safe only while the provider still remembers the key (counted from
  // that attempt). An attempt the provider refused or deferred does not count: nothing was taken, so there is nothing to duplicate. This
  // holds for a retry by hand too (a send that failed for another reason in between keeps the mark): the person is told ONCE to look in the
  // provider's log, and the mark is cleared as they are told, so their next retry is their decision and goes.
  const unanswered = before ? maybeAcceptedAt(before) : null;
  if (unanswered !== null && now - unanswered > ESP_RETRY_WINDOW_MS) {
    // Start the retry by hand (if a person makes one) clean: the same key (the provider may still remember it) and no stale mark.
    await env.store.patchSendDelivery(companyId, request.key, { maybeAcceptedAt: null }).catch(() => undefined);
    return fail("The provider did not answer an earlier attempt and it was not tried again within 20 hours, so whether it was delivered is unknown. Look for it in the provider's log (resend.com, Emails) before sending it again: sending it again could deliver it twice.", skipped);
  }
  // A claim that never settled may have reached the provider: write that down now, so a later deferral (which says nothing about it) cannot lose it.
  if (before && unanswered !== null && before.status === "sending" && !Number.isFinite(markedAt(before))) {
    await env.store.patchSendDelivery(companyId, request.key, { maybeAcceptedAt: new Date(unanswered).toISOString() });
  }

  // 6. The daily cap (marketing enforced, everything counted). Reserved in one step, so two sends at once cannot both pass it.
  const day = utcDay(now);
  const count = recipientsOf(outgoing).length;
  const cap = dailyCap(pick.domain!, loaded.config.esp.steadyDailyCap, now);
  // A marketing message with more recipients than the domain will EVER be handed in a day can never reserve: waiting would not help.
  const ceiling = highestDailyCap(pick.domain!, loaded.config.esp.steadyDailyCap);
  if (marketing && count > ceiling) {
    return fail(`Not sent: this message has ${count} recipients and ${domainName} is never handed more than ${ceiling} recipients in a day, so it could never go out whole. Send marketing one recipient per message (Campaigns does), or ask the owner to raise the domain's cap.`, skipped);
  }
  if (!(await env.store.reserveEspSends(companyId, domainName, day, count, marketing ? cap.cap : null))) {
    throw new SendThrottled(`${domainName} may send ${cap.cap} recipients a day${cap.warming ? ` (warm-up day ${cap.day})` : ""} and today's are used up; marketing mail is tried again tomorrow (UTC)`);
  }
  let reserved = true;
  const release = async () => {
    if (!reserved) return;
    reserved = false;
    await env.store.releaseEspSends(companyId, domainName, day, count).catch(() => undefined);
  };

  try {
    if (!(await env.store.claimSend(record, Boolean(options.force)))) {
      const row = await env.store.getSend(companyId, request.key);
      await release();
      // Only a sent or a permanently failed result is ever answered; anything else waits for the retry.
      if (row && (row.status === "sent" || (row.status === "failed" && row.permanent && !options.force))) return resultFromRow(row);
      throw new MailboxError("This message is already being sent");
    }

    let attachments: EspAttachment[] = [];
    try {
      const files = await downloadAttachments(env.fetch, outgoing.attachments ?? []);
      if (files.reduce((sum, file) => sum + file.content.byteLength, 0) > ESP_MAX_ATTACHMENT_BYTES) {
        throw new AttachmentError(`Attachments are larger than the email provider path carries (${ESP_MAX_ATTACHMENT_BYTES / 1024 / 1024} MB). Send a download link instead, or send it from Gmail by hand.`, true);
      }
      attachments = files.map((file) => ({ filename: file.filename, contentType: file.mime, contentBase64: Buffer.from(file.content).toString("base64") }));
    } catch (error) {
      const message = errorMessage(error);
      await release();
      if (error instanceof AttachmentError && error.permanent) {
        await env.store.recordSendFailure(record, message, true);
        return failed(request, message);
      }
      await env.store.markRetrying(record, message).catch(() => undefined);
      throw error;
    }

    const generation = generationOf(before);
    const providerKey = loaded.config.esp.provider;
    // A Gmail `from` carried by this account: the From header (and the SES envelope sender) is the named address, which sits on the verified domain; replies reach that mailbox.
    const built = buildEspEmail({ companyId, account: pick.fromAddress ? { ...account, address: pick.fromAddress } : account, fromName: loaded.config.fromName, request: outgoing, unsubscribeUrl, attachments, generation, sendTag: providerKey === "ses" });
    // After a definitive answer the next attempt (by hand, once the cause is fixed) must not reuse the key the provider may have kept with it,
    // and the mark of an earlier unanswered attempt belonged to that key. (Only the notes change: `delivery_status` is the provider's, and a
    // "failed" left there would hide a later "delivered" once the retry by hand goes out.)
    const answeredForGood = async () => env.store.patchSendDelivery(companyId, request.key, { gen: generation + 1, maybeAcceptedAt: null }).catch(() => undefined);
    if (built.replyToMissing && !pick.fromAddress) warnings.push(`No Reply-To: replies go to ${account.address}, which nobody reads. Give the account a reply-to address (add-sending-domain with replyTo, or the request's replyTo).`);

    const provider = await espProviderFor(env, loaded, { forSending: true });
    if (!provider.ok) {
      await release();
      await env.store.markRetrying(record, provider.blockers.join(" ")).catch(() => undefined);
      throw new EspUnavailable(`The email provider is not ready: ${provider.blockers.join(" ")}`);
    }
    const outcome = provider.batcher && attachments.length === 0 ? await provider.batcher.submit(built.email, domainName) : { ...(await provider.provider.send(built.email)), batched: false };

    if (!outcome.ok) {
      const message = outcome.error;
      switch (outcome.kind) {
        case "rejected": {
          await release();
          const text = `The email provider refused the message: ${message}`;
          await env.store.recordSendFailure(record, text, true, skipped);
          await answeredForGood();
          return failed(request, text, skipped);
        }
        case "unverified": {
          await release();
          // The provider says the domain is not verified although we believed it was: believe the provider until it says otherwise.
          await env.store.patchEspDomain(companyId, domainName, { status: "pending" });
          await env.store.setAccountStatus(companyId, account.id, "pending");
          const text = `The email provider says ${domainName} is not verified: ${message} Check the domain's DNS records (list-sending-domains), then check the domain again.`;
          await env.store.recordSendFailure(record, text, true, skipped);
          await answeredForGood();
          return failed(request, text, skipped);
        }
        case "conflict": {
          await release();
          const text = `The provider has an earlier attempt of this message under the same key that differed from this one, so whether it was delivered is unknown. Look in ${lookIn(providerKey)} before sending it again.`;
          await env.store.recordSendFailure(record, text, true, skipped);
          await answeredForGood();
          return failed(request, text, skipped);
        }
        case "config": {
          await release();
          await noteEspState(env.ctx, companyId, { code: "key_refused", detail: message }, now);
          await env.store.markRetrying(record, message).catch(() => undefined);
          if (providerKey === "ses") throw new EspUnavailable(`SES refused the Mailbox's access keys or has paused sending (${message}). The owner must check the keys in the Mailbox settings and the account in the SES console; the send is tried again meanwhile.`);
          throw new EspUnavailable(`The email provider refused the Mailbox's API key (${message}). The owner must create a new key and save it in the Mailbox settings; the send is tried again meanwhile.`);
        }
        case "quota": {
          await release();
          await noteEspState(env.ctx, companyId, { code: "quota", detail: message }, now);
          // A provider that refuses on quota (SES) is not asked again for a minute by any send of the company.
          if (!provider.provider.idempotentSends) pauseEspLimiter(companyId, loaded.config.esp, 60);
          await env.store.markRetrying(record, message).catch(() => undefined);
          throw new EspUnavailable(`The email provider's sending quota is used up (${message}); the send is tried again later.`);
        }
        case "unknown": {
          if (outcome.batched) {
            // The messages of a batch the provider never answered are not sent again one by one: that could deliver them twice.
            const text = "The provider did not answer the batch this message was in, so whether it was delivered is unknown. Look in the provider's log (resend.com, Emails) before sending it again.";
            await env.store.recordSendFailure(record, text, true, skipped);
            return failed(request, text, skipped);
          }
          if (!provider.provider.idempotentSends) {
            // The provider has no idempotency key: repeating the call could deliver the message twice. It stays counted against the day (it may have gone out)
            // and fails for good; the person looks in the console. (A later SES Send event that names this send moves it to sent: T2.)
            reserved = false;
            const text = `SES did not confirm this message (${message}), so whether it was sent is unknown. SES cannot tell a repeat from a new message. Look in ${lookIn(providerKey)} before sending it again: sending it again could deliver it twice.`;
            await env.store.recordSendFailure(record, text, true, skipped);
            return failed(request, text, skipped);
          }
          await release();
          // The provider may have kept it. Write down when its key began to be remembered (the FIRST such attempt: a later retry that is
          // refused or deferred must not move it) BEFORE the send is marked retrying; should the write fail the send stays "sending",
          // which `maybeAcceptedAt` also reads as unanswered.
          await env.store.patchSendDelivery(companyId, request.key, { maybeAcceptedAt: new Date(maybeAcceptedAt(before) ?? now).toISOString() });
          await env.store.markRetrying(record, message).catch(() => undefined);
          throw new EspUnavailable(`The email provider did not answer (${message}); the send is tried again with the same key, so it cannot be delivered twice.`);
        }
        default: {
          // retry: not accepted (rate limit, 503, another request with the same key in progress)
          await release();
          await env.store.markRetrying(record, message).catch(() => undefined);
          throw new SendThrottled(`The email provider asked to wait (${message}); the send is tried again shortly`);
        }
      }
    }

    // The provider has the message. A failure below must not undo that (nor give the day's reservation back): the claim stays, so a later
    // delivery of the same request is found by the provider's key and not sent again.
    reserved = false;
    await noteEspState(env.ctx, companyId, { code: null }, now);
    const providerId = outcome.id;
    const restart = Boolean(pick.domain?.last_sent_at) && now - Date.parse(pick.domain!.last_sent_at!) > WARMUP_IDLE_RESET_DAYS * DAY_MS;
    await env.store.markSendSentProvider(request.key, { provider: providerKey, providerMessageId: providerId, accountId: account.id, fromAddress: account.address, skipped });
    await env.store.noteEspSend(companyId, domainName, new Date(now).toISOString(), restart).catch((error: unknown) => env.ctx.logger.info("Domain send time not recorded", { domain: domainName, error: errorMessage(error) }));
    if (options.draftRowId) {
      await env.store
        .markDraftSentProvider(companyId, options.draftRowId, { context: request.context, sendKey: request.key, fromAddress: account.address })
        .catch((error: unknown) => env.ctx.logger.info("Draft row not updated after send", { key: request.key, error: errorMessage(error) }));
    }
    const health = await domainWarnings(env, account, outgoing);
    const all = [...health, ...warnings];
    return {
      key: request.key,
      status: "sent",
      messageId: `${providerKey}:${providerId}`,
      threadId: null,
      sentAt: new Date(now).toISOString(),
      error: null,
      permanent: false,
      context: request.context,
      provider: providerKey,
      // Where a reply arrives: a provider send has no thread, so the sender that wants to attribute a reply keeps this and the key.
      replyTo: built.email.replyTo ?? null,
      ...(skipped.length ? { suppressed: skipped } : {}),
      ...(all.length ? { warnings: all } : {}),
    };
  } catch (error) {
    // Anything that threw before the provider answered gives the day's reservation back.
    await release();
    throw error;
  }
}
