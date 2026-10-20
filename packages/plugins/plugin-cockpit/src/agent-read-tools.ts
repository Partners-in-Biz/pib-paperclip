/**
 * Read-only agent tools for the Cockpit: repairs-list, governor-state, watchdog-findings.
 * These tools provide agents read access to system state and issue tracking.
 */
import type { ToolResult, ToolRunContext } from "@paperclipai/plugin-sdk";
import { toolFail, toolOk } from "@partnersinbiz/pib-plugin-kit";
import { redactSecrets } from "./watch-model.js";
import { GOVERNOR_NS, GOVERNOR_STATE_KEY } from "./governor.js";
import { listRepairs } from "./repairs.js";
import type { Env } from "./env.js";
import { message } from "./env.js";

function params(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/**
 * Runs read-only agent tools: repairs-list, governor-state, watchdog-findings.
 */
export async function runAgentReadTool(env: Env, name: string, raw: unknown, run: ToolRunContext): Promise<ToolResult> {
  const companyId = run.companyId;
  const p = params(raw);

  try {
    if (name === "repairs-list") {
      const limit = Math.min(100, typeof p.limit === "number" ? Math.max(1, p.limit) : 50);
      const repairs = await listRepairs(env.ctx, companyId, {
        kind: typeof p.kind === "string" ? p.kind : undefined,
        since: typeof p.since === "string" ? p.since : undefined,
        limit,
      });
      const redacted = repairs.map((r) => ({
        id: r.id,
        kind: r.kind,
        targetKind: r.targetKind,
        targetId: r.targetId,
        action: r.action,
        outcome: r.outcome,
        detail: redactSecrets(r.detail),
        actor: r.actor,
        createdAt: r.createdAt,
      }));
      return toolOk(`Found ${redacted.length} repairs.`, { repairs: redacted }) as ToolResult;
    }

    if (name === "governor-state") {
      const stateKey = { scopeKind: "company" as const, scopeId: companyId, namespace: GOVERNOR_NS, stateKey: GOVERNOR_STATE_KEY };
      const raw = await env.ctx.state.get(stateKey);
      const state = raw && typeof raw === "object" && !Array.isArray(raw) ? redactSecrets(JSON.stringify(raw)) : null;
      return toolOk(state ? "Governor state found." : "No governor state.", { state: state ? JSON.parse(state) : null }) as ToolResult;
    }

    if (name === "watchdog-findings") {
      const limit = Math.min(100, typeof p.limit === "number" ? Math.max(1, p.limit) : 50);
      const rows = await env.ctx.db.query<Record<string, unknown>>(
        `SELECT id, identifier, title, description, status, origin_kind
         FROM public.issues
         WHERE company_id = $1 AND hidden_at IS NULL
           AND origin_kind = $2
           AND status NOT IN ('done', 'cancelled')
         ORDER BY created_at DESC
         LIMIT $3`,
        [companyId, "task_watchdog", limit],
      );

      const findings = rows.map((row) => {
        const title = String(row.title ?? "");
        const description = String(row.description ?? "");
        let check: "chain_idle" | "orphan_blocker" | null = null;

        // Tolerantly parse check type from title or description
        if (title.includes("chain_idle:") || description.includes("chain_idle:")) {
          check = "chain_idle";
        } else if (title.includes("orphan_blocker:") || description.includes("orphan_blocker:")) {
          check = "orphan_blocker";
        }

        return {
          identifier: row.identifier ? String(row.identifier) : null,
          title: redactSecrets(title),
          bodyExcerpt: redactSecrets(description.slice(0, 500)),
          check,
        };
      });

      return toolOk(`Found ${findings.length} watchdog findings.`, { findings }) as ToolResult;
    }

    return toolFail(`Unknown tool ${name}`) as ToolResult;
  } catch (error) {
    env.ctx.logger.info("Agent read tool failed", { name, error: message(error) });
    return toolFail(`${name} failed: ${message(error)}`) as ToolResult;
  }
}

export const AGENT_READ_TOOL_NAMES = new Set<string>(["repairs-list", "governor-state", "watchdog-findings"]);
