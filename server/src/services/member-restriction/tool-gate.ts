import type { Db } from "@paperclipai/db";
import { MEMBER_RESTRICTED_CODE, isUuidLike, type MemberRestrictionMode } from "@paperclipai/shared";
import { forbidden } from "../../errors.js";
import { loadAgentRunAuthentication, refreshRunIdentityPerson } from "../../middleware/agent-run-authentication.js";
import { recordMemberRestrictionDenial } from "./admin.js";
import { assertPluginOpenForPerson } from "./plugin-gate.js";
import {
  memberRestrictionModeFor,
  memberRestrictionOrUnavailable,
  memberRestrictionResolver,
  memberRestrictionUnavailable,
  type MemberRestrictionResolver,
} from "./resolver.js";

/**
 * The plugin gate inside the tool dispatcher, and the connector filter
 * (PAR-12608 4.8 "Tools", 4.9 decisions 3 and 4). Both use the run's person
 * as core resolves it at sign-in (C40), never a person named by the caller.
 */

export const CONNECTOR_GATE_RULE_ID = "R-connector";
export const TOOL_RUN_NOT_FOUND_CODE = "TOOL_RUN_NOT_FOUND";

export interface ToolGateDeps {
  db: Db;
  /** Injected only by tests; production reads through the one resolver. */
  resolve?: MemberRestrictionResolver;
}

export interface ToolRunRef {
  companyId: string;
  agentId: string;
  runId: string;
}

async function modeOrUnavailable(db: Db, companyId: string): Promise<MemberRestrictionMode> {
  try {
    return await memberRestrictionModeFor(db, companyId);
  } catch (error) {
    throw memberRestrictionUnavailable(error);
  }
}

/** The run's person (C40); a run that cannot be found is refused. */
async function runPerson(db: Db, run: ToolRunRef): Promise<string | null> {
  let row;
  if (!isUuidLike(run.runId)) row = undefined;
  else try {
    [row] = await loadAgentRunAuthentication(db, run);
    await refreshRunIdentityPerson(db, run, row);
  } catch (error) {
    throw memberRestrictionUnavailable(error);
  }
  if (!row) throw forbidden("This tool call names a run that cannot be found", { code: TOOL_RUN_NOT_FOUND_CODE });
  return row.responsibleUserId?.trim() || null;
}

/**
 * The dispatcher's gate: the plugin must be open to the person the run works
 * for. Mode `off` (and the kill switch) passes without reading the run, so
 * answers stay as today; a run with no person passes as today.
 */
export async function assertPluginToolOpenForRun(
  deps: ToolGateDeps,
  run: ToolRunRef,
  pluginKey: string,
  toolName: string,
): Promise<void> {
  if (await modeOrUnavailable(deps.db, run.companyId) === "off") return;
  const personId = await runPerson(deps.db, run);
  if (!personId) return;
  await assertPluginOpenForPerson(
    { db: deps.db, resolve: deps.resolve ?? memberRestrictionResolver(deps.db) },
    { companyId: run.companyId, personId, pluginKey, target: `tool:${toolName}` },
  );
}

/** The `toolGate` option of the plugin tool dispatcher, for production. */
export function pluginToolGate(db: Db, resolve?: MemberRestrictionResolver) {
  return (input: { pluginKey: string; toolName: string; runContext: ToolRunRef }) =>
    assertPluginToolOpenForRun({ db, resolve }, input.runContext, input.pluginKey, input.toolName);
}

export interface ConnectorSession {
  companyId: string;
  agentId: string | null;
  runId: string | null;
  /** The person a session without a run works for (a delegated gateway client). */
  responsibleUserId?: string | null;
}

/**
 * Who a gateway session works for when he is restricted there, or null when
 * connector tools stay open (mode `off`, the kill switch, no person, or a
 * person not flagged). A failed read throws 503.
 */
export async function connectorRestrictionFor(
  deps: ToolGateDeps,
  session: ConnectorSession,
): Promise<{ personId: string; mode: "report" | "enforce" } | null> {
  if (await modeOrUnavailable(deps.db, session.companyId) === "off") return null;
  const personId = session.runId && session.agentId
    ? await runPerson(deps.db, { companyId: session.companyId, agentId: session.agentId, runId: session.runId })
    : session.responsibleUserId?.trim() || null;
  if (!personId) return null;
  const restriction = await memberRestrictionOrUnavailable(
    deps.resolve ?? memberRestrictionResolver(deps.db), personId, session.companyId,
  );
  if (!restriction.restricted || restriction.mode === "off") return null;
  return { personId, mode: restriction.mode };
}

/** Lists hide connector tools only under `enforce`; `report` lists stay unfiltered (4.2). */
export async function connectorToolsClosedFor(deps: ToolGateDeps, session: ConnectorSession): Promise<boolean> {
  return (await connectorRestrictionFor(deps, session))?.mode === "enforce";
}

/** A connector tool called by name: refused under `enforce`, recorded under `report`. Checked on every call (AC-M6). */
export async function assertConnectorToolOpen(
  deps: ToolGateDeps,
  session: ConnectorSession,
  toolName: string,
): Promise<void> {
  const restriction = await connectorRestrictionFor(deps, session);
  if (!restriction) return;
  await recordMemberRestrictionDenial(deps.db, {
    companyId: session.companyId, personId: restriction.personId, ruleId: CONNECTOR_GATE_RULE_ID,
    target: `connector:${toolName}`, mode: restriction.mode,
  });
  if (restriction.mode === "enforce") {
    throw forbidden("Not available for your access level", { code: MEMBER_RESTRICTED_CODE });
  }
}
