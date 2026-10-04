/**
 * Helpers for the e-sign specs: a booted CRM whose signing pages are written to a temp folder, the canary client, a real client with
 * e-sign turned on, and the deliveries the signing page posts, built the way the host hands them to the worker.
 */
import { mkdtempSync, readFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginWebhookInput } from "@paperclipai/plugin-sdk";
import { afterEach, beforeEach } from "vitest";
import { configurePagesDir } from "../../src/esign-pages.js";
import { resetLeadCaches } from "../../src/lead-capture.js";
import { BOARD, CO, tool } from "./crm.js";
import { rememberPluginUiBase } from "@partnersinbiz/pib-plugin-kit";
import { bootCare as bootCareBase, DAY, decide, sentMail, answerSend, type Booted } from "./care.js";

export { DAY, decide, sentMail, answerSend, CO, BOARD, tool };
export type { Booted };

/** The installation uuid the host serves the plugin's pages under: a signing link is only made once the plugin knows it. */
export const UUID = "0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d";
export const UI_BASE = `/_plugins/${UUID}/ui/`;

/** A booted CRM that already knows its public address (the CRM page reported it), as the live one does. */
export async function bootCare(options: Parameters<typeof bootCareBase>[0] = {}): Promise<Booted> {
  const booted = await bootCareBase(options);
  await rememberPluginUiBase(booted.harness.ctx, UI_BASE);
  return booted;
}

/** The address and browser of a client's visit. Not this server's addresses. */
export const VISITOR_IP = "203.0.113.50";
export const BROWSER = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36";
/** What counts as this machine in a test. */
export const SERVER_IPS: ReadonlySet<string> = new Set(["127.0.0.1", "10.0.0.5"]);

export interface Pages {
  dir: string;
  /** The page file's text, or null when there is none. */
  read(pageId: string): string | null;
  has(pageId: string): boolean;
  all(): string[];
}

let currentDir: string | null = null;

/** In each test of the calling file: a fresh temp folder for the signing pages and clean per-installation caches. */
export function usePages(): Pages {
  beforeEach(() => {
    resetLeadCaches();
    currentDir = mkdtempSync(join(tmpdir(), "crm-pages-"));
    configurePagesDir(currentDir);
  });
  afterEach(() => {
    configurePagesDir(undefined);
    if (currentDir) rmSync(currentDir, { recursive: true, force: true });
    currentDir = null;
  });
  return {
    get dir() {
      return currentDir!;
    },
    read: (pageId) => (existsSync(join(currentDir!, `${pageId}.html`)) ? readFileSync(join(currentDir!, `${pageId}.html`), "utf8") : null),
    has: (pageId) => existsSync(join(currentDir!, `${pageId}.html`)),
    all: () => (existsSync(currentDir!) ? readdirSync(currentDir!).filter((name) => name.endsWith(".html")) : []),
  };
}

/** The canary client (company, contact on @canary.invalid, lead form), made through the real tool. */
export async function canaryClient(booted: Booted): Promise<string> {
  const made = await tool<{ client: string }>(booted.harness, "create-canary-client", {});
  return made.client;
}

/** A person turns e-sign on for a client on the page. */
export async function enableFor(booted: Booted, client = "company:acme", extra: Record<string, unknown> = {}) {
  return booted.harness.performAction<Record<string, any>>("crm.enable-esign", { client, confirm: true, templatesReviewed: true, ...extra }, { companyId: CO, actor: BOARD });
}

export const PROPOSAL = { template: "proposal", title: "SEO retainer", variables: { scope: "Monthly SEO work: audits, content and reporting.", priceMinor: 450_000, price: "Monthly fee" } };

export interface Made {
  documentId: string;
  [key: string]: any;
}

export async function makeDoc(booted: Booted, client: string, extra: Record<string, unknown> = {}): Promise<Made> {
  return tool<Made>(booted.harness, "create-sign-document", { client, ...PROPOSAL, ...extra });
}

/** The link in the queued signing email: the page and its token. */
export function linkIn(text: string): { link: string; pageId: string; token: string } {
  const match = /(https:\/\/[^\s#]+\/ui\/s\/([a-z2-7]{24})\.html)#(pibt_[a-z2-7]{40})/.exec(text);
  if (!match) throw new Error(`no signing link in: ${text.slice(0, 200)}`);
  return { link: `${match[1]}#${match[3]}`, pageId: match[2]!, token: match[3]! };
}

/** Asks for the signing email, approves it as a person and lets the Mailbox confirm it. Returns the link the client got. */
export async function sendAndApprove(booted: Booted, documentId: string, options: { answer?: boolean } = {}) {
  const sent = await tool<Record<string, any>>(booted.harness, "send-for-signature", { documentId });
  booted.emit.mockClear();
  await decide(booted.harness, sent.approvalIssueId, "done", "user");
  const mail = sentMail(booted.emit)[0];
  if (!mail) throw new Error("the approved email was not queued in the Mailbox");
  const link = linkIn(mail.text);
  if (options.answer !== false) await answerSend(booted.harness, mail.key, "sent");
  return { sent, mail, ...link };
}

export function signDelivery(body: Record<string, unknown>, headers: Record<string, string> = {}, raw?: string): PluginWebhookInput {
  const rawBody = raw ?? JSON.stringify(body);
  return { endpointKey: "sign", headers: { "x-real-ip": VISITOR_IP, "user-agent": BROWSER, "content-type": "application/json", ...headers }, rawBody, parsedBody: body, requestId: "req-1" };
}

/** What the page posts when a person signs. */
export function signBody(doc: { pageId: string; contentSha256: string; consentSha256: string }, token: string, extra: Record<string, unknown> = {}) {
  return { action: "sign", pageId: doc.pageId, token, typedName: "Ada Lovelace", consent: true, docSha256: doc.contentSha256, consentSha256: doc.consentSha256, t: 9_000, ...extra };
}
