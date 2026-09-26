/** Setup checklist facts for a company (and optionally one sprint). */
import * as db from "../db.js";
import { buildSetupChecklist, checklistSummary, type SetupFacts, type SetupItem } from "../engine/setup.js";
import { resolveAgent } from "./agent.js";
import { companyInfo, str, type CompanyInfo, type Env, type Params } from "./common.js";
import { requireSprint } from "./context.js";
import { loadServiceAccount } from "./google-access.js";
import { integrationAuth, settingsPath } from "./gsc.js";

async function secretSet(info: CompanyInfo, path: string): Promise<boolean> {
  try {
    return Boolean(await info.loaded.secrets.get(path));
  } catch {
    return false;
  }
}

/** Company-level facts (no sprint). */
export async function companySetupFacts(env: Env, info: CompanyInfo): Promise<SetupFacts> {
  const [sa, agent, pagespeedKey, bingKey, settings] = await Promise.all([
    loadServiceAccount(info),
    resolveAgent(env, info.companyId),
    secretSet(info, "pagespeedApiKey"),
    secretSet(info, "bingApiKey"),
    settingsPath(env, info),
  ]);
  return {
    prefix: info.prefix,
    settingsPath: settings,
    settingsSaved: info.loaded.config.saved,
    serviceAccount: { configured: Boolean(sa.key) || Boolean(sa.error), email: sa.key?.clientEmail ?? null, error: sa.error },
    agent,
    pagespeedKey,
    bingKey,
  };
}

/** One sprint's facts for the checklist. */
export async function sprintSetupFacts(env: Env, sprint: db.Sprint): Promise<NonNullable<SetupFacts["sprint"]>> {
  const [gsc, bing] = await Promise.all([
    db.getIntegration(env.ctx.db, sprint.companyId, sprint.id, "gsc"),
    db.getIntegration(env.ctx.db, sprint.companyId, sprint.id, "bing"),
  ]);
  return {
    siteName: sprint.siteName,
    siteUrl: sprint.siteUrl,
    isClient: Boolean(sprint.clientRef),
    siteAccess: sprint.siteAccess,
    siteProjectId: sprint.siteProjectId,
    repoUrl: sprint.repoUrl,
    changePolicy: sprint.changePolicy,
    autopilotMode: sprint.autopilotMode,
    property: gsc?.status === "connected" ? gsc.propertyUrl : null,
    gscVia: integrationAuth(gsc),
    bingVerified: bing?.status === "enabled",
  };
}

export async function setupChecklist(env: Env, info: CompanyInfo, sprint: db.Sprint | null): Promise<SetupItem[]> {
  const [facts, sprintFacts] = await Promise.all([companySetupFacts(env, info), sprint ? sprintSetupFacts(env, sprint) : Promise.resolve(null)]);
  return buildSetupChecklist({ ...facts, ...(sprintFacts ? { sprint: sprintFacts } : {}) });
}

export async function setupChecklistTool(env: Env, companyId: string, params: Params) {
  const info = await companyInfo(env, companyId);
  const sprintId = str(params, "sprintId");
  const sprint = sprintId ? await requireSprint(env, companyId, sprintId) : null;
  const items = await setupChecklist(env, info, sprint);
  return { ...(sprint ? { sprintId: sprint.id } : {}), summary: checklistSummary(items), items };
}
