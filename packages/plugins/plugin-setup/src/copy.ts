/**
 * "Copy setup from another company": pure helpers (no node imports; the page
 * uses them).
 *
 * Secrets are company-scoped, so a source company's secret refs are never
 * copied. Paperclip entity ids (agents, projects, users) belong to the source
 * company too, so UUID-shaped strings are left out as well. What is left is
 * merged into the target without overwriting anything the target already has.
 */

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = Record<string, unknown>;

interface SchemaNode {
  type?: unknown;
  title?: unknown;
  format?: unknown;
  properties?: Record<string, SchemaNode>;
  items?: SchemaNode;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isPlainObject(value: unknown): value is JsonObject {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function isSecretRefValue(value: unknown): boolean {
  return isPlainObject(value) && value.type === "secret_ref";
}

export interface SecretField {
  path: string;
  title: string;
}

/** Every `format: "secret-ref"` field in a config schema, as dot paths. */
export function secretFields(schema: unknown, prefix = ""): SecretField[] {
  const node = isPlainObject(schema) ? (schema as SchemaNode) : null;
  if (!node) return [];
  const out: SecretField[] = [];
  if (prefix && node.format === "secret-ref") {
    out.push({ path: prefix, title: typeof node.title === "string" && node.title ? node.title : prefix });
    return out;
  }
  if (isPlainObject(node.properties)) {
    for (const [key, child] of Object.entries(node.properties)) {
      out.push(...secretFields(child, prefix ? `${prefix}.${key}` : key));
    }
  }
  return out;
}

export interface Removed {
  path: string;
  reason: "secret" | "company-id";
}

/**
 * The source config without secrets (secret-ref objects anywhere, and any
 * value at a schema secret field) and without company-specific ids.
 */
export function stripSecrets(config: unknown, schema?: unknown): { config: JsonObject; removed: Removed[] } {
  const secretPaths = new Set(secretFields(schema).map((field) => field.path));
  const removed: Removed[] = [];
  const walk = (value: unknown, path: string): unknown => {
    if (path && secretPaths.has(path)) {
      if (value !== undefined && value !== null && value !== "") removed.push({ path, reason: "secret" });
      return undefined;
    }
    if (isSecretRefValue(value)) {
      removed.push({ path, reason: "secret" });
      return undefined;
    }
    if (typeof value === "string" && UUID_RE.test(value.trim())) {
      removed.push({ path, reason: "company-id" });
      return undefined;
    }
    if (Array.isArray(value)) {
      const items: unknown[] = [];
      value.forEach((item, index) => {
        const next = walk(item, `${path}[${index}]`);
        if (next !== undefined) items.push(next);
      });
      return items;
    }
    if (isPlainObject(value)) {
      const out: JsonObject = {};
      for (const [key, child] of Object.entries(value)) {
        const next = walk(child, path ? `${path}.${key}` : key);
        if (next !== undefined) out[key] = next;
      }
      return out;
    }
    return value;
  };
  const result = walk(isPlainObject(config) ? config : {}, "");
  return { config: isPlainObject(result) ? result : {}, removed };
}

/** Nothing there yet: missing, null, empty string or empty list. */
export function isEmptyValue(value: unknown): boolean {
  return value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0);
}

export interface Added {
  path: string;
  value: unknown;
}

/**
 * Deep-merge `source` into `target`, only filling values the target does not
 * have. Objects merge key by key; anything else the target has is kept.
 */
export function mergeMissing(target: unknown, source: unknown): { merged: JsonObject; added: Added[] } {
  const added: Added[] = [];
  const merge = (into: JsonObject, from: JsonObject, prefix: string): JsonObject => {
    const out: JsonObject = { ...into };
    for (const [key, value] of Object.entries(from)) {
      const path = prefix ? `${prefix}.${key}` : key;
      const current = out[key];
      if (isPlainObject(current) && isPlainObject(value)) {
        out[key] = merge(current, value, path);
        continue;
      }
      if (isEmptyValue(current) && !isEmptyValue(value)) {
        if (isPlainObject(value) && Object.keys(value).length === 0) continue;
        out[key] = value;
        added.push({ path, value });
      }
    }
    return out;
  };
  const merged = merge(isPlainObject(target) ? target : {}, isPlainObject(source) ? source : {}, "");
  return { merged, added };
}

export interface CopyPlan {
  merged: JsonObject;
  added: Added[];
  removed: Removed[];
  /** Secret fields the target still has to pick after the copy. */
  secretsToPick: SecretField[];
}

function valueAt(config: JsonObject, path: string): unknown {
  let current: unknown = config;
  for (const key of path.split(".")) {
    if (!isPlainObject(current)) return undefined;
    current = current[key];
  }
  return current;
}

/** Everything the preview shows and the save sends, for one plugin. */
export function planCopy(input: { source: unknown; target: unknown; schema?: unknown }): CopyPlan {
  const stripped = stripSecrets(input.source, input.schema);
  const { merged, added } = mergeMissing(input.target, stripped.config);
  const secretsToPick = secretFields(input.schema).filter((field) => isEmptyValue(valueAt(merged, field.path)));
  return { merged, added, removed: stripped.removed, secretsToPick };
}

/** Short display text for a copied value. */
export function previewValue(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > 80 ? `${text.slice(0, 77)}…` : text;
}
