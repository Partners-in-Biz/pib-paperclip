/**
 * Client posts belong in the client's space.
 *
 * Agents drafted Velox and Lumen posts as PiB's own work and as My Social
 * drafts (2026-11-03): they showed on PiB's own Social page and could only
 * target PiB's or Peet's accounts. An agent post that names a CRM client
 * company (its name as written, or its domain) but is not filed under that
 * client is refused with the client to pass. A post that is about a client
 * on purpose (a PiB case study, a founder post) says so with
 * `namesClientOnPurpose: true`.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { listClients, formatClientParam, type ClientScope, type CrmClient } from "./clients.js";
import { SocialError } from "./domain.js";

/** Names this short are too often ordinary words. */
const MIN_NAME = 4;

function escape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Whole-word, as written: "Velox", "#Velox" and "Velox's" match; "velox" and "Veloxity" do not. */
function namePattern(name: string): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{N}])${escape(name)}(?![\\p{L}\\p{N}])`, "u");
}

function bareDomain(domain: string | null): string | null {
  const value = domain?.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");
  return value && value.includes(".") ? value : null;
}

/** CRM client companies a text names. Contacts are people; their names are too common to match. */
export function clientsNamed(clients: CrmClient[], texts: Array<string | null | undefined>): CrmClient[] {
  const text = texts.filter((t): t is string => typeof t === "string" && t.length > 0).join("\n");
  if (!text) return [];
  const lower = text.toLowerCase();
  return clients.filter((client) => {
    if (client.kind !== "company") return false;
    const name = client.name.trim();
    if (name.length >= MIN_NAME && namePattern(name).test(text)) return true;
    const domain = bareDomain(client.domain);
    return domain !== null && lower.includes(domain);
  });
}

/** Text of the per-platform overrides (text, title, description...). */
export function overrideTexts(overrides: unknown): string[] {
  if (!overrides || typeof overrides !== "object") return [];
  const out: string[] = [];
  for (const entry of Object.values(overrides as Record<string, unknown>)) {
    if (!entry || typeof entry !== "object") continue;
    for (const value of Object.values(entry as Record<string, unknown>)) if (typeof value === "string") out.push(value);
  }
  return out;
}

/**
 * Refuse an agent post that names a client it is not filed under.
 * `scope` is where the post will live: null = own work, or a client;
 * `personal` = a person's My Social draft.
 */
export async function assertClientFiling(
  ctx: PluginContext,
  companyId: string,
  input: { texts: Array<string | null | undefined>; scope: ClientScope; personal?: boolean; onPurpose?: unknown },
): Promise<void> {
  if (input.onPurpose === true) return;
  const named = clientsNamed(await listClients(ctx, companyId), input.texts);
  const target = input.personal ? null : input.scope;
  // The CRM can hold two companies of one name: filing under either is fine.
  const targetName = target ? named.find((c) => c.kind === target.kind && c.id === target.id)?.name : undefined;
  const foreign = named.filter((c) => !(target && c.kind === target.kind && c.id === target.id) && c.name !== targetName);
  if (!foreign.length) return;
  // Clients with a domain first: of two CRM rows with one name, that is usually the real one.
  const ordered = [...foreign].sort((a, b) => Number(!a.domain) - Number(!b.domain));
  const list = ordered.map((c) => `${c.name}${c.domain ? ` (${c.domain})` : ""}: client "${formatClientParam({ kind: c.kind, id: c.id })}"`).join("; ");
  const where = input.personal ? "a personal My Social draft" : target ? "another client's post" : "your company's own post";
  throw new SocialError(
    `This post names a CRM client but would be ${where}. A client's post goes in that client's space: use create-post with ${list}. ` +
      `If it really is about the client on purpose (a case study of your own work, a founder post), pass namesClientOnPurpose: true.`,
  );
}
