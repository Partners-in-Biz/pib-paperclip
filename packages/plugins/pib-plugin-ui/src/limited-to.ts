/**
 * A limited person's companies on a plugin page (access stage B2, PAR-15212). A limited person works on one of his
 * own client companies at a time; the worker's page load opens one (the one named, else his first by name) and sends
 * `limitedTo` with the list. The plugins send it in two shapes:
 *
 * - `{ client, clients }`: `client` is `company:<id>` / `contact:<id>`; `clients` holds `{ client, name }` items or
 *   bare keys (Social, whose names sit in the load's own client list).
 * - `{ scopeKey, scopeKeys }`: the Ads form, with the names in the load's `clients` map.
 *
 * `readLimitedTo` reads either into one shape for `LimitedClientPicker`. Anything else (no `limitedTo`: the switch is
 * off, or the person is not limited) is null, and the page shows no picker. The picker only shapes the screen: the
 * worker's guard refuses a client that is not his whatever the page sends.
 */

export interface LimitedClient {
  /** `company:<id>` or `contact:<id>`. */
  client: string;
  name: string;
}

export interface LimitedTo {
  /** The client the page shows now. */
  client: string;
  /** His clients, in the worker's order (by name); always holds `client`. */
  clients: LimitedClient[];
}

/** Names by client key: a map (`{ "company:1": "Acme" }`) or a list of `{ client, name }` rows. */
export type LimitedClientNames = Readonly<Record<string, string>> | ReadonlyArray<{ client?: unknown; name?: unknown }>;

const CLIENT_KEY = /^(company|contact):\S/;

function isClientKey(value: unknown): value is string {
  return typeof value === "string" && CLIENT_KEY.test(value);
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function nameLookup(names: LimitedClientNames | undefined): (key: string) => string | null {
  if (!names) return () => null;
  if (Array.isArray(names)) {
    const map = new Map<string, string>();
    for (const row of names as ReadonlyArray<{ client?: unknown; name?: unknown }>) {
      const name = text(row?.name);
      if (isClientKey(row?.client) && name && !map.has(row.client)) map.set(row.client, name);
    }
    return (key) => map.get(key) ?? null;
  }
  const record = names as Readonly<Record<string, string>>;
  return (key) => (Object.hasOwn(record, key) ? text(record[key]) : null);
}

/** What the picker shows for a client whose name the page does not have. */
export function unnamedClient(key: string): string {
  return key.startsWith("contact:") ? "Unnamed contact" : "Unnamed company";
}

/** Reads a load's `limitedTo` (either shape); null when there is none or it cannot be read. */
export function readLimitedTo(raw: unknown, names?: LimitedClientNames): LimitedTo | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const current = r.client ?? r.scopeKey;
  const list = r.clients ?? r.scopeKeys;
  if (!isClientKey(current) || !Array.isArray(list)) return null;
  const nameOf = nameLookup(names);
  const clients: LimitedClient[] = [];
  const seen = new Set<string>();
  for (const item of list as unknown[]) {
    const row = item && typeof item === "object" ? (item as { client?: unknown; name?: unknown }) : null;
    const key = row ? row.client : item;
    if (!isClientKey(key) || seen.has(key)) continue;
    seen.add(key);
    clients.push({ client: key, name: text(row?.name) ?? nameOf(key) ?? unnamedClient(key) });
  }
  if (!seen.has(current)) clients.unshift({ client: current, name: nameOf(current) ?? unnamedClient(current) });
  return { client: current, clients };
}
