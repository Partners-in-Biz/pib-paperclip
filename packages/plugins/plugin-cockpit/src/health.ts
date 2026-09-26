/**
 * The hourly health alert: one open "System health" issue per company while
 * something is broken (a `bad` check, a plugin not reporting, an agent in
 * error or at 80%+ of its budget). Assigned to the Operator when linked,
 * else the owner. Updated as problems change; closed when all is ok.
 */
import { createHash } from "node:crypto";
import { configSaved, createWorkIssue, isModuleEnabled, readConfig, wakeIssue } from "@partnersinbiz/pib-plugin-kit";
import { ORIGIN, PLUGIN_KEY } from "./constants.js";
import { clearHealthIssue, getHealthIssue, getRoles, listRoles, listSnapshots, saveHealthIssue } from "./db.js";
import { message, readInstalled, type Env } from "./env.js";
import { agentHealth, parseSnapshot, staleChecks, type AgentLite, type CockpitSnapshot, type HealthEntry } from "./merge.js";
import { ownSnapshot } from "./own.js";
import { operatorAgentId } from "./roles.js";

const CLOSED = new Set(["done", "cancelled"]);

export function fingerprint(title: string, description: string): string {
  return createHash("sha256").update(`${title}\n${description}`).digest("hex").slice(0, 32);
}

/** Paperclip path → link with the company prefix (https URLs unchanged). */
export function linkFor(href: string, prefix: string | null): string {
  if (/^https?:\/\//i.test(href)) return href;
  const path = href.startsWith("/") ? href : `/${href}`;
  return prefix ? `/${prefix}${path}` : path;
}

export function toAgentLite(agent: Record<string, unknown>): AgentLite {
  const iso = (value: unknown) => (value instanceof Date ? value.toISOString() : typeof value === "string" ? value : null);
  return {
    id: String(agent.id),
    name: String(agent.name ?? "Agent"),
    title: typeof agent.title === "string" ? agent.title : null,
    role: typeof agent.role === "string" ? agent.role : null,
    urlKey: typeof agent.urlKey === "string" ? agent.urlKey : null,
    status: String(agent.status ?? ""),
    budgetMonthlyCents: Number(agent.budgetMonthlyCents ?? 0) || 0,
    spentMonthlyCents: Number(agent.spentMonthlyCents ?? 0) || 0,
    lastRunAt: iso(agent.lastHeartbeatAt),
    errorReason: typeof agent.errorReason === "string" ? agent.errorReason : null,
    pauseReason: typeof agent.pauseReason === "string" ? agent.pauseReason : null,
  };
}

export async function listAgents(env: Env, companyId: string): Promise<AgentLite[]> {
  try {
    const agents = await env.ctx.agents.list({ companyId, limit: 200 });
    return (agents as unknown as Array<Record<string, unknown>>).map(toAgentLite);
  } catch (error) {
    env.ctx.logger.info("Cockpit agent list failed", { companyId, error: message(error) });
    return [];
  }
}

/** Stored snapshots of plugins whose module is on (newest per plugin). */
export async function storedSnapshots(env: Env, companyId: string): Promise<Array<{ snapshot: CockpitSnapshot; receivedAt: string }>> {
  const rows = await listSnapshots(env.ctx, companyId, "cockpit");
  const out: Array<{ snapshot: CockpitSnapshot; receivedAt: string }> = [];
  for (const row of rows) {
    if (!(await isModuleEnabled(env.ctx, companyId, row.pluginKey))) continue;
    const snapshot = parseSnapshot(row.payload, row.pluginKey);
    if (snapshot) out.push({ snapshot, receivedAt: row.receivedAt });
  }
  return out;
}

/** Plugins that should be reporting: known from a snapshot, or installed and ready; module on. */
export async function expectedPlugins(env: Env, companyId: string, known: string[]): Promise<string[]> {
  const installed = await readInstalled(env.ctx);
  const keys = new Set(known);
  for (const [key, entry] of Object.entries(installed ?? {})) {
    if (entry.status === "ready" && key !== PLUGIN_KEY && key !== "partnersinbiz.setup") keys.add(key);
  }
  const out: string[] = [];
  for (const key of keys) if (await isModuleEnabled(env.ctx, companyId, key)) out.push(key);
  return out.sort();
}

export interface Problems {
  entries: HealthEntry[];
  /** Stable keys, to notice new problems. */
  keys: string[];
}

/** Everything the System health issue lists, worst first. */
export async function collectProblems(env: Env, companyId: string, input?: { snapshots?: CockpitSnapshot[]; agents?: AgentLite[]; listeningSince?: string | null }): Promise<Problems> {
  const stored = input?.snapshots
    ? input.snapshots.map((snapshot) => ({ snapshot, receivedAt: snapshot.checkedAt }))
    : [...(await storedSnapshots(env, companyId)), { snapshot: await ownSnapshot(env, companyId), receivedAt: env.now().toISOString() }];
  const roles = input?.listeningSince !== undefined ? null : await getRoles(env.ctx, companyId);
  const listeningSince = input?.listeningSince !== undefined ? input.listeningSince : roles?.createdAt ?? null;
  const entries: HealthEntry[] = [];
  for (const { snapshot } of stored) {
    for (const check of snapshot.health) {
      if (check.status === "bad") entries.push({ ...check, plugin: snapshot.plugin, pluginTitle: snapshot.title });
    }
  }
  const last = Object.fromEntries(stored.map(({ snapshot }) => [snapshot.plugin, snapshot.checkedAt]));
  const expected = await expectedPlugins(env, companyId, Object.keys(last));
  entries.push(...staleChecks({ expected, lastSnapshot: last, now: env.now(), listeningSince }));
  entries.push(...agentHealth(input?.agents ?? (await listAgents(env, companyId))));
  const rank = { bad: 0, warn: 1, ok: 2 } as const;
  entries.sort((a, b) => rank[a.status] - rank[b.status] || a.pluginTitle.localeCompare(b.pluginTitle) || a.title.localeCompare(b.title));
  return { entries, keys: entries.map((entry) => `${entry.plugin}:${entry.key}`) };
}

export interface HealthIssueContent {
  title: string;
  description: string;
}

/** Title and description of the System health issue (pure). Null when all is ok. */
export function healthIssueContent(entries: HealthEntry[], prefix: string | null): HealthIssueContent | null {
  if (entries.length === 0) return null;
  const bad = entries.filter((entry) => entry.status === "bad").length;
  const lines = [
    `${entries.length} ${entries.length === 1 ? "problem needs" : "problems need"} attention${bad ? ` (${bad} serious)` : ""}. Each one says what to do. This issue updates itself every hour and closes when everything is ok.`,
    "",
    `[Open the Cockpit](${linkFor("/cockpit", prefix)})`,
  ];
  let group = "";
  for (const entry of entries) {
    if (entry.pluginTitle !== group) {
      group = entry.pluginTitle;
      lines.push("", `## ${group}`, "");
    }
    const parts = [`- [ ] **${entry.status === "bad" ? "Problem" : "Warning"}: ${entry.title}**`];
    if (entry.detail) parts.push(`— ${entry.detail}`);
    if (entry.href) parts.push(`[Open](${linkFor(entry.href, prefix)})`);
    lines.push(parts.join(" "));
    if (entry.fix) lines.push(`  - Fix: ${entry.fix}`);
  }
  return {
    title: `System health: ${entries.length} ${entries.length === 1 ? "problem" : "problems"}`,
    description: lines.join("\n"),
  };
}

export type HealthRefresh =
  | { action: "skipped"; reason: string }
  | { action: "created" | "updated" | "unchanged" | "closed" | "none"; issueId: string | null; problems: number };

async function companyPrefix(env: Env, companyId: string): Promise<string | null> {
  try {
    return (await env.ctx.companies.get(companyId))?.issuePrefix ?? null;
  } catch {
    return null;
  }
}

async function healthIssueOn(env: Env, companyId: string): Promise<boolean> {
  try {
    return (await readConfig(env.ctx, companyId)).healthIssue !== false;
  } catch {
    return true;
  }
}

/** Keep the one System health issue for the company current. */
export async function refreshHealthIssue(env: Env, companyId: string, problems?: Problems): Promise<HealthRefresh> {
  const roles = await getRoles(env.ctx, companyId);
  if (!roles) return { action: "skipped", reason: "Cockpit settings not saved" };
  if (!(await healthIssueOn(env, companyId))) return { action: "skipped", reason: "health issue switched off" };
  const found = problems ?? (await collectProblems(env, companyId));
  const content = healthIssueContent(found.entries, await companyPrefix(env, companyId));
  const existing = await getHealthIssue(env.ctx, companyId);
  const issue = existing ? await env.ctx.issues.get(existing.issueId, companyId).catch(() => null) : null;
  const open = issue && !CLOSED.has(String(issue.status)) ? issue : null;
  const now = env.now().toISOString();

  if (!content) {
    if (open) {
      await env.ctx.issues.update(open.id, { status: "done" }, companyId);
      try {
        await env.ctx.issues.createComment(open.id, "Everything is ok again. Closed by the Cockpit.", companyId);
      } catch (error) {
        env.ctx.logger.info("Health close comment skipped", { error: message(error) });
      }
      await clearHealthIssue(env.ctx, companyId);
      return { action: "closed", issueId: open.id, problems: 0 };
    }
    if (existing) await clearHealthIssue(env.ctx, companyId);
    return { action: "none", issueId: null, problems: 0 };
  }

  const operator = await operatorAgentId(env, companyId);
  const owner = roles.ownerUserId;
  const print = fingerprint(content.title, content.description);
  if (open) {
    const reassign = operator
      ? open.assigneeAgentId !== operator && !open.assigneeUserId
        ? { assigneeAgentId: operator }
        : null
      : !open.assigneeAgentId && !open.assigneeUserId && owner
        ? { assigneeUserId: owner }
        : null;
    if (existing?.fingerprint === print && !reassign) return { action: "unchanged", issueId: open.id, problems: found.entries.length };
    await env.ctx.issues.update(open.id, { title: content.title, description: content.description, ...(reassign ?? {}) }, companyId);
    await saveHealthIssue(env.ctx, { companyId, issueId: open.id, fingerprint: print, problemKeys: found.keys }, now);
    const before = new Set(existing?.problemKeys ?? []);
    const fresh = found.keys.some((key) => !before.has(key));
    const assignee = reassign?.assigneeAgentId ?? open.assigneeAgentId ?? null;
    if ((fresh || reassign) && assignee) await wakeIssue(env.ctx, open.id, companyId, "New system health problems");
    return { action: "updated", issueId: open.id, problems: found.entries.length };
  }
  const created = await createWorkIssue(env.ctx, {
    companyId,
    title: content.title,
    description: content.description,
    priority: found.entries.some((entry) => entry.status === "bad") ? "high" : "medium",
    originKind: ORIGIN.health as `plugin:${string}`,
    originId: `health:${companyId}`,
    ...(operator ? { assigneeAgentId: operator } : owner ? { assigneeUserId: owner } : {}),
    wakeReason: "System health problems",
  });
  await saveHealthIssue(env.ctx, { companyId, issueId: created.id, fingerprint: print, problemKeys: found.keys }, now);
  return { action: "created", issueId: created.id, problems: found.entries.length };
}

/** Hourly job: every company with saved Cockpit settings. */
export async function healthAlerts(env: Env): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const row of await listRoles(env.ctx)) {
    let key: string;
    if (!(await configSaved(env.ctx, row.companyId))) key = "skipped";
    else {
      try {
        key = (await refreshHealthIssue(env, row.companyId)).action;
      } catch (error) {
        key = "failed";
        env.ctx.logger.info("System health issue failed", { companyId: row.companyId, error: message(error) });
      }
    }
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

