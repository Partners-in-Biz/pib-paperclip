/**
 * The tamper-evident audit trail of a signable document (audit Q1b-11, Q10-14).
 *
 * Every step of a document's life is one row in `sign_events`. Each row carries the SHA-256 of the row before it
 * (the first one starts from a hash of the document's id and the SHA-256 of its text), so changing or removing any row
 * breaks every hash after it. The hash of the row that records the signature is kept on the document and printed on the
 * signed copy, and it travels in the `deal.accepted` hand-off to Billing, so the head is held outside this table too.
 *
 * What this proves, and what it does not: it shows that the trail was not edited after the fact by anyone who does
 * not also rewrite every later row AND the copies of the head held elsewhere. It does not prove who typed the name
 * (nothing can, with a link in an email); it records the typed name, the time, a keyed hash of the network address, the
 * browser identification and the exact text.
 *
 * The pure functions (hashing, verifying) are tested without a database; `appendEvent` is the one writer.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { sha256Hex } from "./esign-render.js";
import { eventsOf, insertEvent, lastEvent, type SignEvent } from "./esign-store.js";

/** Stable JSON: keys sorted, so the same facts always hash the same. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value === undefined ? null : value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).filter((key) => record[key] !== undefined).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

/** Where a document's chain starts: ties the trail to this document and this exact text. */
export function genesisHash(docId: string, contentSha256: string): string {
  return sha256Hex(`pib-esign:v1:${docId}:${contentSha256}`);
}

export interface EventFacts {
  docId: string;
  seq: number;
  kind: string;
  at: string;
  actor: string;
  ipHash: string | null;
  userAgent: string | null;
  detail: Record<string, unknown>;
}

export function eventHash(prevHash: string, facts: EventFacts): string {
  return sha256Hex(`${prevHash}\n${canonicalJson(facts)}`);
}

export interface ChainCheck {
  ok: boolean;
  problems: string[];
  /** The hash of the last row, or the genesis hash for an empty trail. */
  head: string;
  events: number;
}

/** Recomputes the chain from the first row. Names the first row that does not fit. */
export function verifyChain(docId: string, contentSha256: string, events: readonly SignEvent[]): ChainCheck {
  const problems: string[] = [];
  let prev = genesisHash(docId, contentSha256);
  let expected = 1;
  for (const event of events) {
    if (event.docId !== docId) {
      problems.push(`Row ${event.seq} belongs to another document.`);
      break;
    }
    if (event.seq !== expected) {
      problems.push(`The trail jumps from row ${expected - 1} to row ${event.seq}: a row is missing.`);
      break;
    }
    if (event.prevHash !== prev) {
      problems.push(`Row ${event.seq} (${event.kind}) does not follow the row before it.`);
      break;
    }
    const again = eventHash(prev, { docId: event.docId, seq: event.seq, kind: event.kind, at: event.at, actor: event.actor, ipHash: event.ipHash, userAgent: event.userAgent, detail: event.detail });
    if (again !== event.hash) {
      problems.push(`Row ${event.seq} (${event.kind}) was changed after it was written.`);
      break;
    }
    prev = event.hash;
    expected += 1;
  }
  return { ok: problems.length === 0, problems, head: prev, events: events.length };
}

export interface NewEvent {
  kind: string;
  actor: string;
  at?: string;
  ipHash?: string | null;
  userAgent?: string | null;
  detail?: Record<string, unknown>;
}

/** Each lost race lets one writer through, so the last of N writers needs N tries; the pause spreads them out. */
const MAX_ATTEMPTS = 40;

/**
 * Appends one row to a document's trail. Two writers can race for the same row number; the unique index lets only one
 * through, and the loser reads the trail again and takes the next number. Returns the row written.
 */
export async function appendEvent(ctx: PluginContext, doc: { id: string; companyId: string; contentSha256: string }, input: NewEvent): Promise<SignEvent> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const last = await lastEvent(ctx, doc.companyId, doc.id);
    const seq = (last?.seq ?? 0) + 1;
    const prevHash = last?.hash ?? genesisHash(doc.id, doc.contentSha256);
    const facts: EventFacts = {
      docId: doc.id,
      seq,
      kind: input.kind,
      at: input.at ?? new Date().toISOString(),
      actor: input.actor,
      ipHash: input.ipHash ?? null,
      userAgent: input.userAgent ? input.userAgent.slice(0, 300) : null,
      detail: input.detail ?? {},
    };
    const hash = eventHash(prevHash, facts);
    const row = { companyId: doc.companyId, ...facts, prevHash, hash };
    if (await insertEvent(ctx, row)) return { id: "", ...row };
    await new Promise((resolve) => setTimeout(resolve, Math.floor(Math.random() * 12)));
  }
  throw new Error("The audit trail could not be extended: too many writers at once. Nothing was lost; try again.");
}

/** The whole trail with its check, for a tool. */
export async function loadTrail(ctx: PluginContext, doc: { id: string; companyId: string; contentSha256: string }): Promise<{ events: SignEvent[]; check: ChainCheck }> {
  const events = await eventsOf(ctx, doc.companyId, doc.id, 1000);
  return { events, check: verifyChain(doc.id, doc.contentSha256, events) };
}
