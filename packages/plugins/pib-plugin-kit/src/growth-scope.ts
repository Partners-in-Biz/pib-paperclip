/**
 * Growth scope: what work applies to. Scopes are named (own, a specific client,
 * a product, a book) and serialized as scope keys.
 */

import type { ClientScope } from "./client-ref.js";

export type ScopeKey =
  | { type: "own" }
  | { type: "client"; kind: "company" | "contact"; ref: string }
  | { type: "product"; projectId: string }
  | { type: "book"; projectId: string };

/**
 * Format a scope as a string: "own", "client:<kind>:<ref>", "product:<projectId>", or "book:<projectId>".
 * Throws if ref or projectId is empty, or if kind is invalid.
 */
export function formatScopeKey(scope: ScopeKey): string {
  switch (scope.type) {
    case "own":
      return "own";
    case "client": {
      if (!scope.ref) throw new Error("client ref must not be empty");
      if (scope.kind !== "company" && scope.kind !== "contact") {
        throw new Error(`invalid client kind: ${scope.kind}`);
      }
      return `client:${scope.kind}:${scope.ref}`;
    }
    case "product": {
      if (!scope.projectId) throw new Error("product projectId must not be empty");
      return `product:${scope.projectId}`;
    }
    case "book": {
      if (!scope.projectId) throw new Error("book projectId must not be empty");
      return `book:${scope.projectId}`;
    }
  }
}

/**
 * Parse a scope key string. Throws Error on malformed input.
 * Format: "own", "client:<kind>:<ref>", "product:<projectId>", "book:<projectId>".
 * For client, ref may contain colons but must be non-empty.
 * Product and book IDs must be non-empty.
 */
export function parseScopeKey(raw: string): ScopeKey {
  if (!raw || typeof raw !== "string") {
    throw new Error("invalid scope key: empty or not a string");
  }

  if (raw === "own") {
    return { type: "own" };
  }

  const colonIndex = raw.indexOf(":");
  if (colonIndex === -1) {
    throw new Error(`invalid scope key: ${raw}`);
  }

  const prefix = raw.slice(0, colonIndex);
  const rest = raw.slice(colonIndex + 1);

  if (prefix === "client") {
    const secondColonIndex = rest.indexOf(":");
    if (secondColonIndex === -1) {
      throw new Error(`invalid scope key: ${raw}`);
    }

    const kind = rest.slice(0, secondColonIndex);
    const ref = rest.slice(secondColonIndex + 1);

    if (!kind || !ref) {
      throw new Error(`invalid scope key: ${raw}`);
    }

    if (kind !== "company" && kind !== "contact") {
      throw new Error(`invalid scope key: ${raw}`);
    }

    return { type: "client", kind, ref };
  }

  if (prefix === "product") {
    if (!rest) {
      throw new Error(`invalid scope key: ${raw}`);
    }
    return { type: "product", projectId: rest };
  }

  if (prefix === "book") {
    if (!rest) {
      throw new Error(`invalid scope key: ${raw}`);
    }
    return { type: "book", projectId: rest };
  }

  throw new Error(`invalid scope key: ${raw}`);
}

/**
 * Convert a ClientScope to a ScopeKey.
 * null/undefined becomes {type: "own"}.
 */
export function scopeFromClient(client: ClientScope | undefined): ScopeKey {
  if (!client) {
    return { type: "own" };
  }
  return { type: "client", kind: client.kind, ref: client.id };
}
