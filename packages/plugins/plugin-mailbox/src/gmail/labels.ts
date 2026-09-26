/** Gmail label ids by name, created once per account and cached on the account row. */
import { createLabel, GmailApiError, listLabels, type FetchLike } from "./api.js";
import type { GmailStore } from "../db.js";
import type { AccountRow } from "./types.js";

function cleanName(name: string): string {
  return name.replace(/[\r\n\t]/g, " ").replace(/\s+/g, " ").replace(/\/+/g, "/").replace(/^\/|\/$/g, "").trim().slice(0, 200);
}

function parentsOf(name: string): string[] {
  const parts = name.split("/");
  return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join("/"));
}

export async function ensureLabelIds(
  fetchImpl: FetchLike,
  store: GmailStore,
  account: AccountRow,
  token: string,
  names: string[],
): Promise<Record<string, string>> {
  const wanted = [...new Set(names.map(cleanName).filter(Boolean))];
  const cache: Record<string, string> = { ...(account.label_ids ?? {}) };
  const out: Record<string, string> = {};
  const missing = wanted.filter((name) => {
    if (cache[name]) out[name] = cache[name]!;
    return !cache[name];
  });
  if (missing.length === 0) return out;
  const found: Record<string, string> = {};
  const byLower = new Map((await listLabels(fetchImpl, token)).map((label) => [label.name.toLowerCase(), label.id]));
  const lookup = (name: string) => byLower.get(name.toLowerCase());
  for (const name of missing) {
    for (const parent of [...parentsOf(name), name]) {
      if (lookup(parent)) continue;
      try {
        const created = await createLabel(fetchImpl, token, parent);
        if (created.id) byLower.set(parent.toLowerCase(), created.id);
      } catch (error) {
        // 409: created meanwhile (or differs only in case); read the list again.
        if (!(error instanceof GmailApiError) || error.status !== 409) throw error;
        for (const label of await listLabels(fetchImpl, token)) byLower.set(label.name.toLowerCase(), label.id);
      }
    }
    const id = lookup(name);
    if (id) {
      found[name] = id;
      out[name] = id;
    }
  }
  if (Object.keys(found).length > 0) {
    await store.mergeLabelIds(account.id, found);
    account.label_ids = { ...cache, ...found };
  }
  return out;
}
