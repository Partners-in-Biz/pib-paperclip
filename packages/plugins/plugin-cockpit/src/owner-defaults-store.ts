import type { PluginContext } from "@paperclipai/plugin-sdk";
import {
  POLICY_CLASSES,
  type PolicyClass,
  type OwnerDefaultsPolicy,
  pinDeadline,
} from "./owner-defaults-model.js";

export const OWNER_DEFAULTS_STATE_KEY = "ownerDefaults";
export const DISABLED_POLICY: OwnerDefaultsPolicy = {
  enabled: false,
  name: "",
  rootIssueIds: [],
  classes: [],
  minHours: null,
};

const STATE_CONFIG = (companyId: string) => ({
  scopeKind: "company" as const,
  scopeId: companyId,
  namespace: "cockpit",
  stateKey: OWNER_DEFAULTS_STATE_KEY,
});

export function parseOwnerDefaults(payload: unknown): OwnerDefaultsPolicy {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return DISABLED_POLICY;
  }
  const row = payload as Record<string, unknown>;
  const enabled = row.enabled === true;
  const name =
    typeof row.name === "string" ? row.name.trim().slice(0, 80) : "";
  const minHours =
    typeof row.minHours === "number" &&
    Number.isFinite(row.minHours) &&
    row.minHours > 0
      ? row.minHours
      : null;
  const rootIds = new Set<string>();
  if (Array.isArray(row.rootIssueIds)) {
    for (const id of row.rootIssueIds) {
      if (typeof id === "string") {
        const trimmed = id.trim();
        if (trimmed && !/\s/.test(trimmed)) {
          rootIds.add(trimmed);
          if (rootIds.size >= 20) break;
        }
      }
    }
  }
  const classes: PolicyClass[] = [];
  const classSet = new Set<PolicyClass>();
  if (Array.isArray(row.classes)) {
    for (const cls of row.classes) {
      if (
        POLICY_CLASSES.includes(cls as PolicyClass) &&
        !classSet.has(cls as PolicyClass)
      ) {
        classes.push(cls as PolicyClass);
        classSet.add(cls as PolicyClass);
      }
    }
  }
  const finalEnabled = enabled && rootIds.size > 0 && classes.length > 0;
  return {
    enabled: finalEnabled,
    name: finalEnabled ? name : "",
    rootIssueIds: finalEnabled ? Array.from(rootIds) : [],
    classes: finalEnabled ? classes : [],
    minHours: finalEnabled ? minHours : null,
  };
}

export async function readOwnerDefaults(
  ctx: Pick<PluginContext, "state">,
  companyId: string
): Promise<OwnerDefaultsPolicy> {
  try {
    return parseOwnerDefaults(await ctx.state.get(STATE_CONFIG(companyId)));
  } catch {
    return DISABLED_POLICY;
  }
}

export async function writeOwnerDefaults(
  ctx: Pick<PluginContext, "state">,
  companyId: string,
  policy: OwnerDefaultsPolicy
): Promise<OwnerDefaultsPolicy> {
  const normalized = parseOwnerDefaults(policy);
  await ctx.state.set(STATE_CONFIG(companyId), normalized);
  return normalized;
}

/**
 * Pin an ask deadline in the store. First write wins: once a key is set,
 * subsequent calls with the same key ignore new firstAskedAt/hours and return
 * the existing deadline. Entries with deadlines >30 days past are evicted
 * when the store exceeds 500 entries. Returns null (escalate) if: state
 * operations fail, deadline computation fails, or eviction would require
 * dropping a recent/live pin.
 */
export async function pinAskDeadline(
  ctx: Pick<PluginContext, "state">,
  companyId: string,
  askKey: string,
  firstAskedAt: string,
  hours: number
): Promise<string | null> {
  if (typeof askKey !== "string" || askKey.length === 0 || askKey.length > 200) {
    return null;
  }
  if (!firstAskedAt || Number.isNaN(Date.parse(firstAskedAt))) {
    return null;
  }
  const dc = {
    scopeKind: "company" as const,
    scopeId: companyId,
    namespace: "cockpit",
    stateKey: "ownerDefaultsDeadlines",
  };
  try {
    const stored = await ctx.state.get(dc);
    let dl: Record<string, string | null>;
    if (stored === null || stored === undefined) {
      dl = {};
    } else if (!isPlainObject(stored)) {
      return null;
    } else {
      dl = stored as Record<string, string | null>;
    }
    const ex = dl[askKey];
    if (ex && !Number.isNaN(Date.parse(ex))) {
      return ex;
    }
    const nd = pinDeadline(null, firstAskedAt, hours);
    if (!nd) {
      return null;
    }
    const upd: Record<string, string | null> = { ...dl, [askKey]: nd };
    if (Object.keys(upd).length > 500) {
      const now = Date.now();
      const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
      const afterEvict: Record<string, string | null> = {};
      for (const [k, v] of Object.entries(upd)) {
        if (!v || typeof v !== "string") {
          continue;
        }
        try {
          const d = new Date(v).getTime();
          if (d >= now - thirtyDaysMs) {
            afterEvict[k] = v;
          }
        } catch {
          afterEvict[k] = v;
        }
      }
      if (Object.keys(afterEvict).length > 500) {
        return null;
      }
      await ctx.state.set(dc, afterEvict);
      return nd;
    }
    await ctx.state.set(dc, upd);
    return nd;
  } catch {
    return null;
  }
}

/**
 * Check if a value is a plain object (not null, not Array, not a primitive).
 */
function isPlainObject(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.prototype.toString.call(value) === "[object Object]"
  );
}
