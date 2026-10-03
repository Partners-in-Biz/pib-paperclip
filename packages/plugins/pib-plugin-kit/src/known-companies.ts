/**
 * The companies a plugin has served, remembered in instance-scoped state.
 *
 * Why. A plugin job needs company ids from somewhere. `ctx.companies.list` is
 * the obvious source, but the host refuses it with "unknown invocation scope"
 * whenever another call (a tool, an action, an event) is in flight in the same
 * worker: live logs show hundreds of those refusals for billing, payroll and
 * SEO ("Company list unavailable for the Cockpit push"). Instance-scoped state
 * names no company, so the host never gates it. Every company-scoped entry point
 * that reaches the kit (`createSkillSyncer`, `registerCompanyBootstrap`,
 * `syncAllCompanies`) remembers its company here, and jobs read the list back.
 *
 * This list only says which companies exist for the plugin. It does not let a
 * job act for them: the host still lets a job name only companies that have a
 * saved config row for the plugin (see `syncAllCompanies`).
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";

const KNOWN_COMPANIES_STATE = { scopeKind: "instance" as const, namespace: "pib-kit", stateKey: "known-companies" };
const MAX_KNOWN = 500;

interface Memo {
  /** Companies already written by this worker, so a hot path costs one Set lookup. */
  written: Set<string>;
  chain: Promise<void>;
}

/** One memo per plugin context (one per worker in production). */
const memos = new WeakMap<object, Memo>();

function memoOf(ctx: PluginContext): Memo {
  let memo = memos.get(ctx);
  if (!memo) {
    memo = { written: new Set(), chain: Promise.resolve() };
    memos.set(ctx, memo);
  }
  return memo;
}

function idsOf(value: unknown): string[] {
  const ids = value && typeof value === "object" ? (value as { ids?: unknown }).ids : null;
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string" && id.length > 0) : [];
}

/** Remembers a company. Never throws; writes are serialised so concurrent calls do not lose each other. */
export function rememberCompany(ctx: PluginContext, companyId: string | null | undefined): Promise<void> {
  const memo = memoOf(ctx);
  if (!companyId || memo.written.has(companyId)) return Promise.resolve();
  const next = memo.chain.then(async () => {
    try {
      const ids = idsOf(await ctx.state.get(KNOWN_COMPANIES_STATE));
      if (!ids.includes(companyId)) await ctx.state.set(KNOWN_COMPANIES_STATE, { ids: [...ids, companyId].slice(-MAX_KNOWN) });
      memo.written.add(companyId);
    } catch {
      // state unavailable: the next call tries again
    }
  });
  memo.chain = next;
  return next;
}

/** Every company this plugin has remembered (empty before the first company-scoped call). */
export async function knownCompanyIds(ctx: PluginContext): Promise<string[]> {
  try {
    return idsOf(await ctx.state.get(KNOWN_COMPANIES_STATE));
  } catch {
    return [];
  }
}

/** Forgets what this worker already wrote (tests). */
export function resetKnownCompaniesMemo(ctx: PluginContext): void {
  memos.delete(ctx);
}
