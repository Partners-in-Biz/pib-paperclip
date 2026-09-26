/**
 * Who a piece of work is for.
 *
 * PiB runs one Paperclip company. Its own work (its own socials, SEO,
 * campaigns) carries no client. Client work carries a CRM company or a CRM
 * contact (a sole trader is a contact). Plugin pages read `?client=` to know
 * which: no param means own work, `company:<id>` or `contact:<id>` means that
 * client's workspace.
 *
 * Browser-safe: no node imports, so plugin UIs import it by subpath.
 */

export type ClientKind = "company" | "contact";

export interface ClientRef {
  kind: ClientKind;
  id: string;
}

/** `null` is own work. */
export type ClientScope = ClientRef | null;

export const CLIENT_PARAM = "client";

const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export function isClientKind(value: unknown): value is ClientKind {
  return value === "company" || value === "contact";
}

/** Parses `company:<id>` / `contact:<id>`. Anything else is own work. */
export function parseClientParam(value: string | null | undefined): ClientScope {
  if (!value) return null;
  const at = value.indexOf(":");
  if (at <= 0) return null;
  const kind = value.slice(0, at);
  const id = value.slice(at + 1);
  if (!isClientKind(kind) || !ID_RE.test(id)) return null;
  return { kind, id };
}

export function formatClientParam(ref: ClientRef): string {
  return `${ref.kind}:${ref.id}`;
}

/** Reads the scope from a location search string (`?a=b&client=…`). */
export function clientScopeFromSearch(search: string | null | undefined): ClientScope {
  return parseClientParam(new URLSearchParams(search ?? "").get(CLIENT_PARAM));
}

/**
 * Adds or replaces `client=` on a plugin path such as `/social?tab=posts`.
 * Own scope removes it.
 */
export function withClientParam(path: string, scope: ClientScope): string {
  const hashAt = path.indexOf("#");
  const hash = hashAt >= 0 ? path.slice(hashAt) : "";
  const beforeHash = hashAt >= 0 ? path.slice(0, hashAt) : path;
  const queryAt = beforeHash.indexOf("?");
  const pathname = queryAt >= 0 ? beforeHash.slice(0, queryAt) : beforeHash;
  const params = new URLSearchParams(queryAt >= 0 ? beforeHash.slice(queryAt + 1) : "");
  if (scope) params.set(CLIENT_PARAM, formatClientParam(scope));
  else params.delete(CLIENT_PARAM);
  const query = params.toString();
  return `${pathname}${query ? `?${query}` : ""}${hash}`;
}

/**
 * Accepts what tools, actions and the UI send: `{ client: {kind,id} | null }`,
 * `{ client: "company:<id>" }`, or the flat `{ clientKind, clientRef }` pair
 * (kind defaults to company, the only kind before contacts were allowed).
 * Returns `undefined` when the input says nothing about the client.
 */
export function clientScopeFromInput(input: Record<string, unknown> | null | undefined): ClientScope | undefined {
  if (!input) return undefined;
  if ("client" in input) {
    const value = input.client;
    if (value === null || value === "" || value === "own") return null;
    if (typeof value === "string") return parseClientParam(value) ?? undefined;
    if (value && typeof value === "object") {
      const v = value as { kind?: unknown; id?: unknown };
      if (isClientKind(v.kind) && typeof v.id === "string" && ID_RE.test(v.id)) return { kind: v.kind, id: v.id };
    }
    return undefined;
  }
  if ("clientRef" in input) {
    const ref = input.clientRef;
    if (ref === null || ref === "") return null;
    if (typeof ref !== "string" || !ID_RE.test(ref)) return undefined;
    const kind = isClientKind(input.clientKind) ? input.clientKind : "company";
    return { kind, id: ref };
  }
  return undefined;
}

export function sameClient(a: ClientScope, b: ClientScope): boolean {
  if (!a || !b) return a === b;
  return a.kind === b.kind && a.id === b.id;
}

/** The row's scope from its `client_kind` / `client_ref` columns. */
export function scopeOfRow(row: { client_kind?: string | null; client_ref?: string | null }): ClientScope {
  if (!row.client_ref) return null;
  return { kind: isClientKind(row.client_kind) ? row.client_kind : "company", id: row.client_ref };
}

/**
 * SQL filter for a scope. `n` is the next free `$` index. Own work is
 * `client_ref IS NULL`; a client matches kind and id.
 */
export function clientWhere(scope: ClientScope, n: number, alias = ""): { sql: string; params: unknown[] } {
  const col = (name: string) => (alias ? `${alias}.${name}` : name);
  if (!scope) return { sql: `${col("client_ref")} IS NULL`, params: [] };
  return {
    sql: `${col("client_ref")} = $${n + 1} AND COALESCE(${col("client_kind")}, 'company') = $${n}`,
    params: [scope.kind, scope.id],
  };
}
