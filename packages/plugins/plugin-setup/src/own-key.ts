/**
 * "This company bills on its own key" (PAR-5209). The host stamps every
 * finished run with `usageJson.billingType`: `metered_api` when the agent ran
 * on an API key, `subscription_included` when it ran on a subscription login.
 * A client company must be on its own key; the newest `claude_local` run says
 * which one it actually used. Pure: the page fetches the runs and the owner
 * flag, this decides what to show.
 */
import type { SetupItem } from "./kit-setup.js";

export const OWN_KEY_ITEM = "own-key-billing";
export const RUNS_LIMIT = 20;

export interface RunLite {
  adapterType: string;
  billingType: string;
  at: number;
}

const rec = (value: unknown): Record<string, unknown> => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});

function time(row: Record<string, unknown>): number {
  for (const field of ["finishedAt", "startedAt", "createdAt"]) {
    const value = row[field];
    const ms = typeof value === "string" ? Date.parse(value) : NaN;
    if (!Number.isNaN(ms)) return ms;
  }
  return 0;
}

/** The runs that report a billing type (a queued or running run has no usage yet), newest first. Null when the body is not a run list. */
export function parseRuns(body: unknown): RunLite[] | null {
  const list = Array.isArray(body) ? body : Array.isArray(rec(body).data) ? (rec(body).data as unknown[]) : Array.isArray(rec(body).runs) ? (rec(body).runs as unknown[]) : null;
  if (!list) return null;
  const out: RunLite[] = [];
  for (const raw of list) {
    const row = rec(raw);
    const billingType = rec(row.usageJson).billingType;
    if (typeof row.adapterType !== "string" || typeof billingType !== "string") continue;
    out.push({ adapterType: row.adapterType, billingType, at: time(row) });
  }
  return out.sort((a, b) => b.at - a.at);
}

const base = { key: OWN_KEY_ITEM, required: false } as const;

/**
 * The checklist item for a company, or null when there is nothing to say:
 * PiB's own company keeps its subscription, and an unreadable owner flag or run
 * list must not raise a false alarm.
 */
export function ownKeyItem(runs: RunLite[] | null, ownerCompany: boolean | null): SetupItem | null {
  if (ownerCompany !== false || runs === null) return null;
  const latest = runs.find((run) => run.adapterType === "claude_local");
  if (!latest) {
    return { ...base, title: "This company bills on its own key", status: "unknown", detail: "No finished Claude agent run yet. After the Model key step, let an agent run once and this shows which key it used." };
  }
  if (latest.billingType === "metered_api") {
    return { ...base, title: "This company bills on its own key", status: "done", detail: "The latest Claude agent run was billed to the company's own API key." };
  }
  if (latest.billingType === "subscription_included") {
    return {
      ...base,
      title: "This company's agents run on Partners in Biz's subscription",
      status: "missing",
      detail: "The latest Claude agent run used the Partners in Biz subscription, not the company's own key. Bind the key on the Model key step, then let an agent run once more to confirm.",
      steps: ["Run the Model key step on the New company tab (or bind the company secret ANTHROPIC_API_KEY to the Claude agents).", "Let any Claude agent run once, then reopen this page."],
    };
  }
  return { ...base, title: "This company bills on its own key", status: "unknown", detail: `The latest Claude agent run reports its billing as "${latest.billingType}", so Setup cannot tell which key it used.` };
}
