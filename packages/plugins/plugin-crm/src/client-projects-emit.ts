import { readConfig, type ClientProjectsEvent } from "@partnersinbiz/pib-plugin-kit";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { table } from "./db.js";

interface ClientProjectRow {
  client_kind: "company" | "contact";
  client_ref: string;
  project_id: string;
  kind: string | null;
  created_at: string;
  id: string;
}

/**
 * Emits client.projects.updated with the client's full current link set (both shapes) when the emitClientProjects flag is on; an empty set emits []. Off: nothing is read or sent. Never throws: a failure is logged without values.
 */
export async function emitClientProjects(
  ctx: PluginContext,
  companyId: string,
  client: { clientKind: "company" | "contact"; clientRef: string },
): Promise<boolean> {
  try {
    const config = await readConfig(ctx, companyId);
    if (config.emitClientProjects !== true) {
      return false;
    }

    // Query links for this client
    const rows = await ctx.db.query<ClientProjectRow>(
      `SELECT client_kind, client_ref, project_id, kind, created_at, id
       FROM ${table(ctx, "client_projects")}
       WHERE company_id = $1 AND client_kind = $2 AND client_ref = $3
       ORDER BY created_at, id`,
      [companyId, client.clientKind, client.clientRef],
    );

    // Build the payload
    const projectIds = rows.map((row) => row.project_id);
    const projects = rows.map((row) => ({
      projectId: row.project_id,
      kind: row.kind,
    }));

    const payload: ClientProjectsEvent = {
      clientKind: client.clientKind,
      clientRef: client.clientRef,
      projectIds,
      projects,
      updatedAt: new Date().toISOString(),
    };

    // Emit the event
    await ctx.events.emit("client.projects.updated", companyId, payload);
    return true;
  } catch (error) {
    const errorName = error instanceof Error ? error.constructor.name : "Unknown";
    ctx.logger.warn("CRM client projects emit failed", {
      companyId,
      clientKind: client.clientKind,
      error: errorName,
    });
    return false;
  }
}

/**
 * Emit client.projects.updated for all clients in a company that have links.
 * Returns the count of distinct clients for which emission was attempted.
 * On error, logs a warning and continues without throwing.
 */
export async function emitClientProjectsForCompany(ctx: PluginContext, companyId: string): Promise<number> {
  try {
    const config = await readConfig(ctx, companyId);
    if (config.emitClientProjects !== true) {
      return 0;
    }

    // Find distinct (client_kind, client_ref) pairs
    const rows = await ctx.db.query<{
      client_kind: "company" | "contact";
      client_ref: string;
    }>(
      `SELECT DISTINCT client_kind, client_ref
       FROM ${table(ctx, "client_projects")}
       WHERE company_id = $1
       ORDER BY client_kind, client_ref`,
      [companyId],
    );

    let emitted = 0;
    for (const row of rows) {
      const success = await emitClientProjects(ctx, companyId, {
        clientKind: row.client_kind,
        clientRef: row.client_ref,
      });
      if (success) {
        emitted++;
      }
    }

    return emitted;
  } catch (error) {
    ctx.logger.warn("CRM client projects company emit failed", {
      companyId,
      error: error instanceof Error ? error.constructor.name : "Unknown",
    });
    return 0;
  }
}
