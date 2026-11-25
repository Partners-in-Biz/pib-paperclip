/**
 * Hourly merged-PR check (PAR-14492). An open ask-owner question that only
 * asks the owner to merge GitHub PRs is settled once GitHub says every one of
 * them is merged: a factual comment (merge commit, time), the ask closed, and
 * the issue handed back to its agent (`todo`, woken) or, for an Unblock issue,
 * closed with the work it blocked woken. An open, closed-unmerged or unreadable
 * PR changes nothing; a grant, money, legal or login ask is never touched.
 */
import { readConfig, SecretResolver } from "@partnersinbiz/pib-plugin-kit";
import { askHardStop, listOpenAsks, settleAskByFact, type AskRow } from "./asks.js";
import { message, type Env } from "./env.js";
import { allMerged, isUnblockIssue, mergeAskPrs, mergedAnswer, mergedComment, mergedWakeReason, prStateFrom, type PrRef, type PrState } from "./pr-merge-model.js";

/** The settings secret the PR state is read with (the GitHub token the credential check already uses). */
export const PR_TOKEN_PATH = "credentialChecks.github";
/** GitHub calls one company's check may make per run. */
export const MAX_PR_LOOKUPS = 25;
const TIMEOUT_MS = 10_000;
const CLOSED = new Set(["done", "cancelled"]);

export interface PrMergeCounts {
  checked: number;
  handedBack: number;
  closed: number;
  woken: number;
  waiting: number;
  unknown: number;
}

type FetchLike = (url: string, init?: Record<string, unknown>) => Promise<{ status: number; json(): Promise<unknown> }>;

/**
 * One PR's state from GitHub. Never throws and never waits past `TIMEOUT_MS`,
 * even when the call ignores its abort signal; the token is used for this call and dropped.
 */
export async function readPrState(fetchImpl: FetchLike, pr: PrRef, token: string | undefined): Promise<PrState> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<PrState>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ state: "unknown", detail: `GitHub did not answer in ${TIMEOUT_MS / 1000} s` });
    }, TIMEOUT_MS);
  });
  const read = (async (): Promise<PrState> => {
    try {
      const headers: Record<string, string> = { "user-agent": "partnersinbiz-cockpit", accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" };
      if (token) headers.authorization = `Bearer ${token}`;
      const res = await fetchImpl(`https://api.github.com/repos/${encodeURIComponent(pr.owner)}/${encodeURIComponent(pr.repo)}/pulls/${pr.number}`, { method: "GET", headers, signal: controller.signal });
      if (res.status !== 200) return { state: "unknown", detail: `GitHub answered ${res.status}` };
      return prStateFrom(await res.json().catch(() => null));
    } catch (error) {
      return { state: "unknown", detail: message(error).slice(0, 80) };
    }
  })();
  try {
    return await Promise.race([read, timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

/** Wakes each agent-held issue the closed one blocked once nothing open blocks it any more. */
async function wakeReadyDependents(env: Env, companyId: string, issueId: string, ref: string, askId: string): Promise<number> {
  let woken = 0;
  const relations = await env.ctx.issues.relations.get(issueId, companyId).catch(() => null);
  for (const dep of relations?.blocks ?? []) {
    if (dep.status !== "blocked" || !dep.assigneeAgentId) continue;
    try {
      const own = await env.ctx.issues.relations.get(dep.id, companyId);
      if ((own.blockedBy ?? []).some((b) => b.id !== issueId && !CLOSED.has(String(b.status)))) continue;
      await env.ctx.issues.requestWakeup(dep.id, companyId, {
        reason: `${ref} is closed: the PR it waited on is merged. Nothing open blocks ${dep.identifier ?? "this issue"} now; check the result and carry on.`,
        idempotencyKey: `pr-merged:${askId}:${dep.id}`,
      });
      woken += 1;
    } catch (error) {
      env.ctx.logger.info("Merged-PR check: a blocked issue was not woken", { companyId, issueId: dep.id, error: message(error) });
    }
  }
  return woken;
}

/** The PRs an open ask waits on, or null when a merge can never settle it. */
function asksForPrs(ask: AskRow): PrRef[] | null {
  const decided = mergeAskPrs({ kind: ask.kind, question: ask.question, why: ask.why, steps: ask.steps, links: ask.links, hasEffect: !!ask.effect, hardStop: askHardStop(ask) });
  return "prs" in decided ? decided.prs : null;
}

/** Hourly, for one company. Safe to run twice: an ask is closed before anything else changes. */
export async function reconcileMergedPrAsks(env: Env, companyId: string, options: { maxLookups?: number } = {}): Promise<PrMergeCounts> {
  const out: PrMergeCounts = { checked: 0, handedBack: 0, closed: 0, woken: 0, waiting: 0, unknown: 0 };
  const candidates = (await listOpenAsks(env, companyId, 200)).map((ask) => ({ ask, prs: asksForPrs(ask) })).filter((c): c is { ask: AskRow; prs: PrRef[] } => !!c.prs);
  if (candidates.length === 0) return out;

  let token: string | undefined;
  try {
    token = await new SecretResolver(env.ctx, companyId, await readConfig(env.ctx, companyId)).get(PR_TOKEN_PATH);
  } catch (error) {
    // Public repos still read without one; a private one answers 404 and changes nothing.
    env.ctx.logger.info("Merged-PR check: the GitHub token could not be read", { companyId, error: message(error).slice(0, 80) });
  }
  const fetchImpl = (env.fetchImpl ?? fetch) as unknown as FetchLike;
  const states = new Map<string, PrState>();
  let budget = options.maxLookups ?? MAX_PR_LOOKUPS;

  for (const { ask, prs } of candidates) {
    try {
      // Stop reading at the first PR not merged: one open PR is enough to wait.
      for (const pr of prs) {
        if (!states.has(pr.key)) {
          if (budget <= 0) break;
          budget -= 1;
          states.set(pr.key, await readPrState(fetchImpl, pr, token));
        }
        if (states.get(pr.key)!.state !== "merged") break;
      }
      out.checked += 1;
      const merges = allMerged(prs, states);
      if (!merges) {
        if (prs.some((pr) => states.get(pr.key)?.state === "unknown")) out.unknown += 1;
        else out.waiting += 1;
        continue;
      }
      const issue = await env.ctx.issues.get(ask.issueId, companyId).catch(() => null);
      if (!issue) continue;
      const closeIssue = isUnblockIssue({ title: issue.title, description: issue.description });
      const outcome = await settleAskByFact(env, ask, {
        policy: "pr-merged",
        answer: mergedAnswer(merges),
        comment: mergedComment({ question: ask.question, merges, closing: closeIssue }),
        wakeReason: mergedWakeReason(ask.issueIdentifier, merges),
        closeIssue,
      });
      if (outcome === "handed_back") out.handedBack += 1;
      if (outcome === "closed") {
        out.closed += 1;
        out.woken += await wakeReadyDependents(env, companyId, ask.issueId, ask.issueIdentifier ?? ask.issueId, ask.id);
      }
    } catch (error) {
      env.ctx.logger.info("Merged-PR check failed for an ask", { companyId, askId: ask.id, error: message(error) });
    }
  }
  if (out.unknown) env.ctx.logger.info("Merged-PR check: some PRs could not be read (no token, private repo or GitHub down)", { companyId, unknown: out.unknown });
  return out;
}
