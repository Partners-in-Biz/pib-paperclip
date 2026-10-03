/**
 * A booted CRM for the client care specs: a customer company with a person who can be written to, the Account Manager
 * linked, an owner for approvals, and helpers to decide approvals and answer for the Mailbox.
 */
import { expect, vi } from "vitest";
import type { Row, Route, Store } from "./fake-db.js";
import { ago, BOARD, boot, CO, company, contact, crmIssues, seed, setRoles, tool, toolRaw, type Harness } from "./crm.js";

export { ago, BOARD, CO, crmIssues, seed, setRoles, tool, toolRaw, company, contact };
export type { Harness, Row, Route, Store };

export const OWNER = "user-peet";
export const MAILBOX = "plugin.partnersinbiz.mailbox";
export const DAY = 86_400_000;

/** The default store with Acme (a customer with Ada, who can be emailed) and Sipho Solo (a sole trader and customer). */
export function careSeed(extra: Partial<Store> = {}): Store {
  const base = seed();
  return {
    ...base,
    companies: [
      company("acme", "Acme Plumbing", { domain: "acme.co.za", lifecycle: "customer", tags: ["retainer"] }),
      company("globex", "Globex", { domain: "globex.test" }),
      { ...company("foreign", "Foreign Co"), company_id: "co-2" },
    ],
    ...extra,
  };
}

export async function linkRole(harness: Harness, role: string, agentId: string) {
  harness.seed({ agents: [{ id: agentId, companyId: CO, name: agentId, status: "idle" } as never] });
  await harness.ctx.state.set({ scopeKind: "company", scopeId: CO, namespace: "pib-hire", stateKey: `role:${role}` }, { agentId, linkedAt: "2026-09-28T08:00:00Z", linkedBy: "manual", hire: null });
}

export async function bootCare(options: { store?: Store; routes?: Route[]; config?: Record<string, unknown>; reviewer?: boolean } = {}) {
  const booted = await boot({ store: options.store ?? careSeed(), config: options.config, routes: options.routes });
  await linkRole(booted.harness, "account-manager", "am-1");
  await setRoles(booted.harness, { ownerUserId: OWNER, team: { "account-manager": { agentId: "am-1", status: "idle" } } });
  if (options.reviewer) {
    booted.harness.seed({ agents: [{ id: "rev-1", companyId: CO, name: "Reviewer", status: "idle" } as never] });
    await setRoles(booted.harness, { ownerUserId: OWNER, reviewerAgentId: "rev-1", reviewerStatus: "idle", reviewOutward: true, team: { "account-manager": { agentId: "am-1", status: "idle" } } });
  }
  return booted;
}

export type Booted = Awaited<ReturnType<typeof bootCare>>;

/** Marks an issue done or cancelled and tells the plugin who did it, as the host's issue.updated event does. */
export async function decide(harness: Harness, issueId: string, status: "done" | "cancelled", actor: "user" | "agent" = "user") {
  const issue = (await harness.ctx.issues.get(issueId, CO))!;
  harness.seed({ issues: [{ ...issue, status }] });
  await harness.emit("issue.updated", {}, { companyId: CO, entityId: issueId, actorType: actor, actorId: actor === "user" ? OWNER : "am-1" });
  return (await harness.ctx.issues.get(issueId, CO))!;
}

/** Every issue the CRM opened whose origin id starts with `prefix`. */
export async function issuesWith(harness: Harness, prefix: string) {
  return (await crmIssues(harness)).filter((issue) => String(issue.originId ?? "").startsWith(prefix));
}

/** The mail.send.requested payloads the plugin emitted so far. */
export function sentMail(emit: { mock: { calls: unknown[][] } }): Array<Record<string, any>> {
  return emit.mock.calls.filter((call) => call[0] === "mail.send.requested").map((call) => call[2] as Record<string, any>);
}

/** The Mailbox answers a send. */
export async function answerSend(harness: Harness, key: string, status: "sent" | "failed", extra: Record<string, unknown> = {}) {
  await harness.emit(`${MAILBOX}.mail.send.result` as `plugin.${string}`, { key, status, messageId: "gm-1", threadId: "gt-1", sentAt: new Date().toISOString(), context: { plugin: "partnersinbiz.crm", kind: "client_message", id: key.replace("crm:msg:", "") }, ...extra }, { companyId: CO });
}

export function expectNoSecrets(value: unknown) {
  expect(JSON.stringify(value)).not.toMatch(/pibs_|pibc_|secret|password/i);
}
