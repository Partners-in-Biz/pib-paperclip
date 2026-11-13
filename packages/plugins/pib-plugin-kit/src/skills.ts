/**
 * Versioned managed-skill sync.
 *
 * The host's `skills.managed.reconcile` never rewrites a skill that already
 * exists, so a plugin upgrade would leave agents on stale instructions. This
 * helper hashes each declared skill and calls `reset` (which replaces the
 * content in place, keeping the key and agent attachments) only when the hash
 * changed since the last sync for that company.
 */
import { createHash } from "node:crypto";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { withCompanyMemory } from "./memory.js";
import { withAskingSection } from "./asking.js";
import { withWritingSection } from "./writing.js";
import { rememberCompany } from "./known-companies.js";
import { SKILL_KEPT_TOKENS, renderTokens } from "./tokens.js";

export interface SkillDeclarationLike {
  skillKey: string;
  markdown?: string;
  files?: Array<{ path: string; content: string }>;
}

export interface SkillSyncResult {
  skillKey: string;
  action: "reset" | "reconcile" | "failed";
  error?: string;
}

export function skillVersion(skill: SkillDeclarationLike): string {
  const hash = createHash("sha256");
  hash.update(skill.skillKey);
  hash.update("\0");
  hash.update(skill.markdown ?? "");
  for (const file of [...(skill.files ?? [])].sort((a, b) => a.path.localeCompare(b.path))) {
    hash.update("\0");
    hash.update(file.path);
    hash.update("\0");
    hash.update(file.content);
  }
  return hash.digest("hex").slice(0, 16);
}

function stateKey(companyId: string, skillKey: string) {
  return { scopeKind: "company" as const, scopeId: companyId, namespace: "pib-kit", stateKey: `skill-ver:${skillKey}` };
}

export async function syncManagedSkills(
  ctx: PluginContext,
  companyId: string,
  skills: SkillDeclarationLike[],
  options: { force?: boolean } = {},
): Promise<SkillSyncResult[]> {
  const results: SkillSyncResult[] = [];
  for (const skill of skills) {
    const version = skillVersion(skill);
    try {
      const deployed = options.force ? null : await ctx.state.get(stateKey(companyId, skill.skillKey));
      if (deployed === version) {
        const resolution = (await ctx.skills.managed.reconcile(skill.skillKey, companyId)) as { defaultDrift?: { changedFiles?: string[] } | null } | null;
        // The marker says this version is deployed, but the company's copy can still differ (an upgrade
        // interrupted mid-copy, or an edit): only an unchanged copy counts as up to date.
        if (!resolution?.defaultDrift?.changedFiles?.length) {
          results.push({ skillKey: skill.skillKey, action: "reconcile" });
          continue;
        }
      }
      await ctx.skills.managed.reset(skill.skillKey, companyId);
      await ctx.state.set(stateKey(companyId, skill.skillKey), version);
      results.push({ skillKey: skill.skillKey, action: "reset" });
    } catch (error) {
      results.push({ skillKey: skill.skillKey, action: "failed", error: error instanceof Error ? error.message : String(error) });
    }
  }
  return results;
}

/** How long a tool call or a page load waits for the skill sync before it goes on without it. */
export const SKILL_SYNC_WAIT_MS = 2_000;
/** After a failed sync, `soon` does not start another for that company before this long. */
export const SKILL_SYNC_RETRY_MS = 5 * 60_000;

export interface SkillSyncGuardOptions {
  /** The clock for the retry window, in ms (tests). Defaults to `Date.now`. */
  now?: () => number;
  /** Where a thrown sync is noted. */
  logger?: { info(message: string, meta?: Record<string, unknown>): void };
}

/**
 * The guard for callers that must never wait long for the skill sync: tool
 * calls, page loads and API routes. On a company with many skills the host can
 * take more than 30 seconds to reconcile or reset one skill, and a call that
 * waits for that runs into the host's own 30-second limit (on 13 Nov 2026 that
 * rolled back a Cockpit release and a CRM and Mailbox release at their smoke
 * tests).
 *
 * The returned function starts (or joins) the company's sync through `ensure`,
 * waits at most `waitMs` for it and then lets it finish behind the caller. It
 * never throws. After a failed sync (a `failed` result or a thrown error) it
 * does not call `ensure` again for that company for
 * {@link SKILL_SYNC_RETRY_MS}: a retry on every call only adds load to a host
 * that is already slow.
 *
 * `createSkillSyncer(...).soon` is this guard over the syncer's own `ensure`.
 * Use this directly for a composite (a plugin with two syncers).
 */
export function createSkillSyncGuard(
  ensure: (companyId: string) => Promise<SkillSyncResult[]>,
  options: SkillSyncGuardOptions = {},
): (companyId: string, waitMs?: number) => Promise<void> {
  const now = options.now ?? (() => Date.now());
  const failedAt = new Map<string, number>();
  return async (companyId, waitMs = SKILL_SYNC_WAIT_MS) => {
    const last = failedAt.get(companyId);
    if (last !== undefined && now() - last < SKILL_SYNC_RETRY_MS) return;
    const failed = (error?: unknown) => {
      failedAt.set(companyId, now());
      if (error === undefined) return;
      try {
        options.logger?.info("Managed skill sync failed", { companyId, error: error instanceof Error ? error.message : String(error) });
      } catch {
        // A logger that throws must not reach the caller.
      }
    };
    let sync: Promise<void>;
    try {
      sync = Promise.resolve(ensure(companyId)).then((results) => {
        if (Array.isArray(results) && results.some((r) => r.action === "failed")) failed();
        else failedAt.delete(companyId);
      }, failed);
    } catch (error) {
      failed(error);
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const wait = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, waitMs);
    });
    try {
      await Promise.race([sync, wait]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
}

/**
 * Sync once per company per worker process. Call it from any company-scoped
 * entry point (actions, tools, events, jobs with an explicit company).
 *
 * - `soon`: what a tool call, a page load or an API route uses. Starts or joins
 *   the sync, waits at most 2 seconds, never throws, and leaves a failed sync
 *   alone for 5 minutes ({@link createSkillSyncGuard}).
 * - `ensure`: once per company per process (memoised). Waits for the host, so
 *   only for callers that need the result (team wiring, a new company's
 *   bootstrap) and never in a tool call or a page load.
 * - `force`: always resets every skill.
 * - `check`: syncs only what changed, every time it is called (not memoised);
 *   what `syncAllCompanies` and the periodic sweep use, so a copy that was
 *   edited or left behind is found without a restart.
 *
 * Every call remembers the company (kit `rememberCompany`), so a job can later
 * find the companies this plugin has served without `ctx.companies.list`,
 * which the host refuses while another call is in flight.
 */
export function createSkillSyncer(ctx: PluginContext, skills: SkillDeclarationLike[], options: Pick<SkillSyncGuardOptions, "now"> = {}) {
  const done = new Map<string, Promise<SkillSyncResult[]>>();
  const ensure = (companyId: string): Promise<SkillSyncResult[]> => {
    void rememberCompany(ctx, companyId);
    const existing = done.get(companyId);
    if (existing) return existing;
    const run = syncManagedSkills(ctx, companyId, skills).then((results) => {
      const failed = results.filter((r) => r.action === "failed");
      if (failed.length > 0) {
        done.delete(companyId);
        ctx.logger.info("Managed skill sync incomplete", { companyId, failed });
      }
      return results;
    });
    done.set(companyId, run);
    return run;
  };
  const guard = createSkillSyncGuard(ensure, { now: options.now, logger: ctx.logger });
  return {
    /** The declarations this syncer keeps in step (for drift checks). */
    skills,
    ensure,
    /** For tool calls, page loads and API routes: waits at most `waitMs` (2 s), never throws. */
    soon(companyId: string, waitMs?: number): Promise<void> {
      void rememberCompany(ctx, companyId);
      return guard(companyId, waitMs);
    },
    force(companyId: string): Promise<SkillSyncResult[]> {
      void rememberCompany(ctx, companyId);
      done.delete(companyId);
      const run = syncManagedSkills(ctx, companyId, skills, { force: true });
      done.set(companyId, run);
      return run;
    },
    async check(companyId: string): Promise<SkillSyncResult[]> {
      void rememberCompany(ctx, companyId);
      const results = await syncManagedSkills(ctx, companyId, skills);
      if (results.every((r) => r.action !== "failed")) done.set(companyId, Promise.resolve(results));
      return results;
    },
  };
}

/** What `createSkillSyncer` returns. */
export type SkillSyncer = ReturnType<typeof createSkillSyncer>;

/**
 * Prepend frontmatter with a unique pib- slug so reset never clobbers other
 * company skills, and append the company memory section (read before, write
 * after), the "Asking a person" section and the plain "Writing" section unless `memory: false` (or
 * `asking: false` for the asking section alone).
 */
export function withFrontmatter(input: { name: string; description: string; memory?: boolean; asking?: boolean; writing?: boolean }, body: string): string {
  const description = input.description.replace(/\s+/g, " ").trim().replace(/"/g, "'");
  let content = input.memory === false ? body.trimStart() : withCompanyMemory(body.trimStart());
  if (input.asking !== false && input.memory !== false) content = withAskingSection(content);
  if (input.writing !== false && input.memory !== false) content = withWritingSection(content);
  // Throws on an unknown {{token}}, so a typo fails the plugin's tests and build instead of reaching an agent.
  return renderTokens(`---\nname: ${input.name}\nslug: ${input.name}\ndescription: "${description}"\n---\n\n${content}`, {}, { keep: SKILL_KEPT_TOKENS });
}
