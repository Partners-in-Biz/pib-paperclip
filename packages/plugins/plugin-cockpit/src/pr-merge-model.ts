/**
 * Merged-PR asks (PAR-14492): an agent asks the owner to merge a GitHub PR,
 * then someone else merges it. Nothing waits on the owner any more, but the
 * issue sits in their inbox until they notice. These pure rules decide which
 * open asks are only a merge ask, which PRs they name, and what to say once
 * every one of them is merged. No I/O; `now` is never read here.
 */
import { parseMarker } from "@partnersinbiz/pib-plugin-kit";
import type { HardStopKey } from "./decision-rights-model.js";

export interface PrRef {
  owner: string;
  repo: string;
  number: number;
  /** `owner/repo#n`, the key used for caching and in comments. */
  key: string;
  url: string;
}

/** A PR as GitHub reports it. `unknown`: unreachable, private without a token, or not found. */
export type PrState =
  | { state: "merged"; sha: string | null; mergedAt: string | null; mergedBy: string | null }
  | { state: "open" }
  | { state: "closed" }
  | { state: "unknown"; detail: string };

/** At most this many PRs are read for one ask: a longer list is not a plain merge ask. */
export const MAX_PRS_PER_ASK = 5;

/**
 * Hard stops a merged PR can never settle: the ask is about money, a login,
 * legal words, a store release or deleting data, whatever PR it also links.
 * `client-production` is not here: a merge ask to `main` is that hard stop,
 * and once the PR is merged the question it asked is already answered.
 */
const NEVER_SETTLED_BY_MERGE: ReadonlySet<HardStopKey> = new Set(["money", "logins", "legal", "store-release", "data-delete"]);

const PR_URL = /https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)/gi;

/**
 * The question opens by asking for a merge: "Merge PR #126 ...", "May we merge ...", "Please merge ...".
 * Anything else is not a merge ask, even when it names a merge: "PR #14 is merged; may we put it live?",
 * "Do not merge yet?", "Merge is done; may we deploy?", "Should we wait instead of merging?".
 */
const ASKS_FOR_MERGE = /^\s*(?:(?:ok(?:ay)?|yes)[,:]?\s+)?(?:(?:may|can|shall|should|could|will) (?:we|i|you|someone)\s+|please\s+|ok(?:ay)? to\s+)?merge\s+(?!(?:is|was|has|had|done|already)\b)/i;

/** A second thing asked next to the merge ("... and set the env vars", ", then deploy"): a merge alone does not answer it. */
const ALSO_ASKS = /(?:\band\b|\bthen\b|\balso\b|\bplus\b|\+|&|;|,)\s*(?:then\s+|also\s+)?(?:set|add|store|save|deploy|copy|run|create|give|grant|send|pay|approve|enable|configure|update|rotate|share|publish|release|upload|delete|remove|install|sign|buy|renew)\b/i;

/** GitHub PR links in the texts, in order, each once. */
export function prRefsIn(texts: ReadonlyArray<string | null | undefined>): PrRef[] {
  const out = new Map<string, PrRef>();
  for (const text of texts) {
    if (!text) continue;
    for (const m of text.matchAll(PR_URL)) {
      const owner = m[1]!;
      const repo = m[2]!.replace(/\.git$/i, "");
      const number = Number(m[3]);
      if (!Number.isSafeInteger(number) || number <= 0) continue;
      const key = `${owner}/${repo}#${number}`.toLowerCase();
      if (!out.has(key)) out.set(key, { owner, repo, number, key, url: `https://github.com/${owner}/${repo}/pull/${number}` });
    }
  }
  return [...out.values()];
}

export interface MergeAskFacts {
  kind: string;
  question: string;
  why: string | null;
  steps: readonly string[];
  links: ReadonlyArray<{ label: string; href: string }>;
  /** An answer that does something (an ask effect): its own plugin settles it, never a merge. */
  hasEffect: boolean;
  /** The hard stop the ask is (askHardStop), or null. */
  hardStop: HardStopKey | null;
}

export type MergeAskSkip = "effect" | "not_decision" | "hard_stop" | "not_merge_ask" | "mixed_ask" | "no_pr" | "too_many_prs";

/** Which PRs this open ask is waiting on, or why a merge can never settle it. */
export function mergeAskPrs(ask: MergeAskFacts): { prs: PrRef[] } | { skip: MergeAskSkip } {
  if (ask.hasEffect) return { skip: "effect" };
  // A grant, money, legal or info ask is answered by a person, never by a merge.
  if (ask.kind !== "decision") return { skip: "not_decision" };
  if (ask.hardStop && NEVER_SETTLED_BY_MERGE.has(ask.hardStop)) return { skip: "hard_stop" };
  if (!ASKS_FOR_MERGE.test(ask.question)) return { skip: "not_merge_ask" };
  if (ALSO_ASKS.test(ask.question)) return { skip: "mixed_ask" };
  const prs = prRefsIn([ask.question, ask.why, ...ask.steps, ...ask.links.map((l) => l.href)]);
  if (prs.length === 0) return { skip: "no_pr" };
  if (prs.length > MAX_PRS_PER_ASK) return { skip: "too_many_prs" };
  return { prs };
}

/** Every PR merged: the merge facts in the ask's order. Anything else: null (no-op). */
export function allMerged(prs: readonly PrRef[], states: ReadonlyMap<string, PrState>): Array<{ pr: PrRef; sha: string | null; mergedAt: string | null; mergedBy: string | null }> | null {
  if (prs.length === 0) return null;
  const out: Array<{ pr: PrRef; sha: string | null; mergedAt: string | null; mergedBy: string | null }> = [];
  for (const pr of prs) {
    const s = states.get(pr.key);
    if (!s || s.state !== "merged") return null;
    out.push({ pr, sha: s.sha, mergedAt: s.mergedAt, mergedBy: s.mergedBy });
  }
  return out;
}

/** The PR state from a GitHub `GET /repos/{o}/{r}/pulls/{n}` body. */
export function prStateFrom(body: unknown): PrState {
  if (!body || typeof body !== "object") return { state: "unknown", detail: "GitHub sent no PR." };
  const pr = body as Record<string, unknown>;
  if (pr.merged === true) {
    const by = pr.merged_by && typeof pr.merged_by === "object" ? (pr.merged_by as Record<string, unknown>).login : null;
    return {
      state: "merged",
      sha: typeof pr.merge_commit_sha === "string" && /^[0-9a-f]{7,40}$/i.test(pr.merge_commit_sha) ? pr.merge_commit_sha : null,
      mergedAt: typeof pr.merged_at === "string" && Number.isFinite(Date.parse(pr.merged_at)) ? new Date(pr.merged_at).toISOString() : null,
      mergedBy: typeof by === "string" && /^[A-Za-z0-9-[\]]{1,60}$/.test(by) ? by : null,
    };
  }
  if (pr.state === "open") return { state: "open" };
  if (pr.state === "closed") return { state: "closed" };
  return { state: "unknown", detail: "GitHub sent a PR without a state." };
}

/** An Unblock issue (escalation marker or `Unblock` title): with its merge ask settled, nothing is left on it. */
export function isUnblockIssue(issue: { title?: string | null; description?: string | null }): boolean {
  return !!parseMarker(issue.description ?? null) || /^\s*unblock\b/i.test(issue.title ?? "");
}

function mergeLine(m: { pr: PrRef; sha: string | null; mergedAt: string | null; mergedBy: string | null }): string {
  const parts = [`[${m.pr.key}](${m.pr.url}) merged`];
  if (m.mergedAt) parts.push(`at ${m.mergedAt}`);
  if (m.mergedBy) parts.push(`by ${m.mergedBy}`);
  return `${parts.join(" ")}${m.sha ? `, merge commit \`${m.sha.slice(0, 12)}\`` : ""}.`;
}

/** The one-line answer stored on the ask. */
export function mergedAnswer(merges: ReadonlyArray<{ pr: PrRef; sha: string | null; mergedAt: string | null }>): string {
  return `Merged on GitHub: ${merges.map((m) => `${m.pr.key}${m.sha ? ` (${m.sha.slice(0, 7)})` : ""}${m.mergedAt ? ` at ${m.mergedAt}` : ""}`).join("; ")}.`;
}

/** The factual comment on the issue. */
export function mergedComment(input: { question: string; merges: ReadonlyArray<{ pr: PrRef; sha: string | null; mergedAt: string | null; mergedBy: string | null }>; closing: boolean }): string {
  const lines = [
    `**PR merged: the question is settled.** Checked on GitHub by the Cockpit's hourly merge check.`,
    "",
    ...input.merges.map((m) => `- ${mergeLine(m)}`),
    "",
    `The question "${input.question.replace(/\s+/g, " ").slice(0, 200)}" needs no answer from the owner any more.`,
    input.closing ? "This Unblock issue only waited on that merge, so it is closed and the work it blocked is woken." : "The issue goes back to the agent, who carries on.",
  ];
  return lines.join("\n");
}

/** What the agent the issue goes back to is woken with. */
export function mergedWakeReason(identifier: string | null, merges: ReadonlyArray<{ pr: PrRef; sha: string | null }>): string {
  const on = identifier ? ` on ${identifier}` : "";
  const list = merges.map((m) => `${m.pr.key}${m.sha ? ` (${m.sha.slice(0, 7)})` : ""}`).join(", ");
  return `The PR your question${on} asked the owner to merge is merged: ${list}. Nobody needs to answer it; check the result (deploy, live page) and carry on.`;
}
