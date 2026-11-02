/**
 * GitHub check_suite webhook (`POST /api/plugins/partnersinbiz.cockpit/webhooks/github-ci`).
 *
 * The host route is public and does no signature check, and it gives the plugin no company. So:
 * 1. Companies that saved `githubCi.webhookSecret` are tried; the first whose secret (or, for 24 h after
 *    `githubCi.rotatedAt`, the previous one) matches X-Hub-Signature-256 over the RAW body owns the delivery.
 *    Nothing is parsed before that. No match → 401 and no side effect.
 * 2. Replays are dropped by X-GitHub-Delivery (kept 7 days in plugin state).
 * 3. Only a completed check_suite that failed, timed out or was cancelled, in an allowed owner's repo, on a
 *    `feat/PAR-<n>-…` branch, for an issue that is still open, gets a comment: one per (issue, head sha).
 * Payload text is data: it is cleaned and put in code spans; it is never run or followed.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { PluginContext, PluginWebhookInput } from "@paperclipai/plugin-sdk";
import { readConfig, SecretResolver } from "@partnersinbiz/pib-plugin-kit";

export const GITHUB_CI_ENDPOINT = "github-ci";
export const DEFAULT_ALLOWED_OWNERS = ["Partners-in-Biz"];
export const REPLAY_TTL_MS = 7 * 24 * 3600_000;
export const ROTATION_GRACE_MS = 24 * 3600_000;
const CONCLUSIONS = new Set(["failure", "timed_out", "cancelled"]);
const BRANCH = /^feat\/(PAR-\d+)-/;
const SHA = /^[0-9a-f]{40}$/;
const REPO = /^([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)$/;
const NS = "cockpit";

export interface GithubCiResult {
  status: number;
  outcome: string;
}

type Ctx = Pick<PluginContext, "config" | "secrets" | "state" | "issues" | "companies">;

/** One delivery at a time per (issue, sha): two parallel check suites on one commit make one comment. */
const inflight = new Map<string, Promise<unknown>>();
async function serial<T>(key: string, run: () => Promise<T>): Promise<T> {
  const before = inflight.get(key) ?? Promise.resolve();
  const next = before.catch(() => undefined).then(run);
  inflight.set(key, next);
  try {
    return await next;
  } finally {
    if (inflight.get(key) === next) inflight.delete(key);
  }
}

function header(headers: PluginWebhookInput["headers"], name: string): string {
  for (const [k, v] of Object.entries(headers ?? {})) if (k.toLowerCase() === name) return Array.isArray(v) ? (v[0] ?? "") : v;
  return "";
}

export function sign(secret: string, rawBody: string): string {
  return `sha256=${createHmac("sha256", secret).update(rawBody, "utf8").digest("hex")}`;
}

function matches(secret: string | undefined, rawBody: string, given: string): boolean {
  if (!secret) return false;
  const a = Buffer.from(sign(secret, rawBody));
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The company whose saved secret signed this body, or null. */
async function verifiedCompany(ctx: Ctx, rawBody: string, given: string, now: Date): Promise<string | null> {
  if (!given.startsWith("sha256=")) return null;
  for (const company of await ctx.companies.list()) {
    const config = await readConfig(ctx as PluginContext, company.id).catch(() => ({}) as Record<string, unknown>);
    const ci = config.githubCi as { webhookSecret?: unknown; previousWebhookSecret?: unknown; rotatedAt?: string } | undefined;
    if (!ci?.webhookSecret) continue;
    const secrets = new SecretResolver(ctx as PluginContext, company.id, config);
    if (matches(await secrets.get("githubCi.webhookSecret").catch(() => undefined), rawBody, given)) return company.id;
    const rotated = ci.rotatedAt ? Date.parse(ci.rotatedAt) : NaN;
    if (ci.previousWebhookSecret && Number.isFinite(rotated) && now.getTime() - rotated < ROTATION_GRACE_MS) {
      if (matches(await secrets.get("githubCi.previousWebhookSecret").catch(() => undefined), rawBody, given)) return company.id;
    }
  }
  return null;
}

const clean = (v: unknown, max: number): string => (typeof v === "string" ? v : "").replace(/[^\w .:/@()#+-]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

export async function handleGithubCi(ctx: Ctx, input: Pick<PluginWebhookInput, "headers" | "rawBody">, now: Date = new Date()): Promise<GithubCiResult> {
  const rawBody = input.rawBody ?? "";
  const companyId = await verifiedCompany(ctx, rawBody, header(input.headers, "x-hub-signature-256"), now);
  if (!companyId) return { status: 401, outcome: "bad signature" };

  const ignored = (outcome: string): GithubCiResult => ({ status: 200, outcome: `ignored: ${outcome}` });
  if (header(input.headers, "x-github-event") !== "check_suite") return ignored("event");

  const deliveryId = clean(header(input.headers, "x-github-delivery"), 80);
  if (!deliveryId) return ignored("no delivery id");
  const seen = await ctx.state.get({ scopeKind: "company", scopeId: companyId, namespace: NS, stateKey: `ghci-delivery:${deliveryId}` });
  if (typeof seen === "number" && now.getTime() - seen < REPLAY_TTL_MS) return ignored("replay");

  let body: Record<string, unknown>;
  try {
    body = obj(JSON.parse(rawBody));
  } catch {
    return ignored("not json");
  }
  const suite = obj(body.check_suite);
  if (body.action !== "completed" || !CONCLUSIONS.has(String(suite.conclusion))) return ignored("not a failed completed suite");

  const config = await readConfig(ctx as PluginContext, companyId).catch(() => ({}) as Record<string, unknown>);
  const owners = (Array.isArray(obj(config.githubCi).allowedOwners) ? (obj(config.githubCi).allowedOwners as unknown[]) : DEFAULT_ALLOWED_OWNERS).map((o) => String(o).toLowerCase());
  const repo = REPO.exec(String(obj(body.repository).full_name));
  if (!repo || !owners.includes(repo[1]!.toLowerCase())) return ignored("repository");
  const branch = BRANCH.exec(String(suite.head_branch));
  const sha = String(suite.head_sha);
  if (!branch || !SHA.test(sha)) return ignored("branch or sha");

  const issue = await ctx.issues.get(branch[1]!, companyId).catch(() => null);
  if (!issue || issue.status === "done" || issue.status === "cancelled") return ignored("issue closed or unknown");

  return serial(`${issue.id}:${sha}`, async () => {
    const commentKey = { scopeKind: "company" as const, scopeId: companyId, namespace: NS, stateKey: `ghci-comment:${issue.id}:${sha}` };
    // Claim the delivery and the (issue, sha) before posting, so a retry cannot post twice.
    if (await ctx.state.get(commentKey)) {
      await ctx.state.set({ scopeKind: "company", scopeId: companyId, namespace: NS, stateKey: `ghci-delivery:${deliveryId}` }, now.getTime());
      return ignored("already commented for this commit");
    }
    await ctx.state.set(commentKey, now.getTime());
    const name = clean(obj(suite.app).name, 60) || "check suite";
    const link = `https://github.com/${repo[1]}/${repo[2]}/commit/${sha}/checks?check_suite_id=${Number(suite.id) || 0}`;
    const text = `GitHub CI \`${name}\` ${String(suite.conclusion).replace("_", " ")} on \`${repo[1]}/${repo[2]}\` at \`${sha.slice(0, 12)}\`.\n\nRun: ${link}\n\nFix the checks, push, and say so here.`;
    try {
      await ctx.issues.createComment(issue.id, text, companyId);
    } catch (error) {
      await ctx.state.delete(commentKey);
      throw error;
    }
    await ctx.state.set({ scopeKind: "company", scopeId: companyId, namespace: NS, stateKey: `ghci-delivery:${deliveryId}` }, now.getTime());
    return { status: 200, outcome: "commented" };
  });
}
