/**
 * Guided setup for the Setup plugin (kit `SetupStatus`): the SEO checklist
 * (`engine/setup.ts`) mapped item for item, plus the Site Verification API
 * probe and "first sprint created". Served at GET /setup-status and pushed
 * from the hourly daily job. Read-only.
 *
 * Paths have no company prefix (the Setup page adds it).
 */
import { configSaved, isModuleEnabled, pluginUiBase, publishSetupStatus, settingsItem, type SetupItem, type SetupItemStatus, type SetupStatus } from "@partnersinbiz/pib-plugin-kit";
import * as db from "../db.js";
import { sprintScope, sprintPagePath } from "../engine/scope.js";
import { isRunning } from "../engine/sprint.js";
import {
  buildSetupChecklist,
  GITHUB_PAT_URL,
  githubTokenSteps,
  SEARCH_CONSOLE_API_URL,
  SITE_VERIFICATION_API_URL,
  type SetupItem as EngineItem,
  type SetupFacts,
} from "../engine/setup.js";
import { probeServiceAccountApis, type ApiProbe } from "../integrations/google-sa.js";
import manifest from "../manifest.js";
import { PLUGIN_ID } from "../namespace.js";
import { companyInfo, errorMessage, type CompanyInfo, type Env } from "./common.js";
import { serviceAccountAccess } from "./google-access.js";
import { companySetupFacts, sprintSetupFacts } from "./setup.js";

const PLUGINS_PATH = "/company/settings/instance/plugins";
export const MODULE_OFF_MESSAGE = "SEO is switched off for this company. Turn it on in Setup.";

/** False only when the company switched the SEO module off in Setup. */
export function seoOn(env: Env, companyId: string): Promise<boolean> {
  return isModuleEnabled(env.ctx, companyId, PLUGIN_ID);
}

function installationId(uiBase: string | null): string | null {
  return uiBase ? /\/_plugins\/([^/]+)\//.exec(uiBase)?.[1] ?? null : null;
}

function settingsHref(uiBase: string | null): string {
  const id = installationId(uiBase);
  return id ? `${PLUGINS_PATH}/${id}` : PLUGINS_PATH;
}

/** Engine status → kit status. `warn` means "works, but look at it" for some items. */
function kitStatus(item: EngineItem, warnIs: SetupItemStatus): SetupItemStatus {
  if (item.status === "done") return "done";
  if (item.status === "unknown") return "unknown";
  if (item.status === "warn") return warnIs;
  return "missing";
}

function fromEngine(item: EngineItem, input: { required: boolean; warnIs?: SetupItemStatus; title?: string; blockedBy?: string[] }): SetupItem {
  let status = kitStatus(item, input.warnIs ?? "missing");
  if (!input.required && status === "missing") status = "optional";
  const link = item.links[0] ?? null;
  return {
    key: item.key,
    title: input.title ?? item.label,
    status,
    required: input.required,
    detail: item.detail,
    href: link?.url ?? null,
    hrefLabel: link?.label ?? null,
    steps: item.steps.length ? item.steps : undefined,
    agentNext: item.next,
    ...(input.blockedBy?.length ? { blockedBy: input.blockedBy } : {}),
  };
}

// Probe results per service account, for an hour (the probe costs a token exchange and two calls).
const probeCache = new Map<string, { at: number; value: { siteVerification: ApiProbe; searchConsole: ApiProbe } }>();
const PROBE_TTL_MS = 60 * 60 * 1000;

export function clearProbeCache(): void {
  probeCache.clear();
}

async function probeApis(env: Env, info: CompanyInfo): Promise<{ siteVerification: ApiProbe; searchConsole: ApiProbe } | { error: string } | null> {
  let access: { token: string; email: string } | null;
  try {
    access = await serviceAccountAccess(env, info);
  } catch (error) {
    return { error: errorMessage(error) };
  }
  if (!access) return null;
  const hit = probeCache.get(access.email);
  const now = env.now().getTime();
  if (hit && now - hit.at < PROBE_TTL_MS) return hit.value;
  const value = await probeServiceAccountApis(env.fetch, access.token);
  probeCache.set(access.email, { at: now, value });
  return value;
}

function apiItem(saDone: boolean, probe: Awaited<ReturnType<typeof probeApis>>): SetupItem {
  const base = {
    key: "site_verification_api",
    title: "Enable the Site Verification and Search Console APIs",
    required: true,
    href: SITE_VERIFICATION_API_URL,
    hrefLabel: "Enable Site Verification API",
    steps: [
      `Open ${SITE_VERIFICATION_API_URL} and click **Enable**.`,
      `Open ${SEARCH_CONSOLE_API_URL} and click **Enable**.`,
      "Wait a minute, then check again.",
    ],
    agentNext: "Verifies our own sites itself (gsc-verification-token → repo → gsc-verify-site) and adds the Search Console property.",
  };
  if (!saDone || !probe) return { ...base, status: "blocked", detail: "Needs a working Google service account key first.", blockedBy: ["service_account"] };
  if ("error" in probe) return { ...base, status: "unknown", detail: `Could not check: ${probe.error}` };
  const off = [probe.siteVerification.state === "off" ? "Site Verification API" : null, probe.searchConsole.state === "off" ? "Search Console API" : null].filter(Boolean);
  if (off.length) return { ...base, status: "missing", detail: `${off.join(" and ")} ${off.length === 1 ? "is" : "are"} not enabled for the service account's project.` };
  const unknown = [probe.siteVerification, probe.searchConsole].find((p) => p.state === "unknown");
  if (unknown && unknown.state === "unknown") return { ...base, status: "unknown", detail: `Could not check: ${unknown.message}` };
  return { ...base, status: "done", detail: "Both APIs answer for the service account.", steps: undefined };
}

/** One item for all running sprints: done when every sprint's item is done. */
function sprintAggregate(
  key: string,
  perSprint: Array<{ sprint: db.Sprint; item: EngineItem }>,
  input: { title: string; required: boolean; warnIs?: SetupItemStatus; tab?: string },
): SetupItem {
  const rows = perSprint.map(({ sprint, item }) => ({ sprint, item, status: kitStatus(item, input.warnIs ?? "missing") }));
  const open = rows.filter((r) => r.status !== "done");
  const first = open[0] ?? rows[0]!;
  const href = sprintPagePath("/seo", first.sprint.id, sprintScope(first.sprint), input.tab ? { tab: input.tab } : {});
  let status: SetupItemStatus = open.length === 0 ? "done" : open.some((r) => r.status === "missing") ? "missing" : "unknown";
  if (!input.required && status === "missing") status = "optional";
  const detail = open.length === 0
    ? rows.length === 1 ? `${rows[0]!.sprint.siteName}: ${rows[0]!.item.detail}` : `All ${rows.length} running sprints are set.`
    : open.slice(0, 5).map((r) => `${r.sprint.siteName}: ${r.item.detail}`).join(" ") + (open.length > 5 ? ` (+${open.length - 5} more)` : "");
  return {
    key,
    title: input.title,
    status,
    required: input.required,
    detail,
    href,
    hrefLabel: `Open ${first.sprint.siteName}`,
    steps: open.length && first.item.steps.length ? first.item.steps : undefined,
    agentNext: first.item.next,
  };
}

export async function seoSetupStatus(env: Env, companyId: string): Promise<SetupStatus> {
  const info = await companyInfo(env, companyId);
  const uiBase = await pluginUiBase(env.ctx).catch(() => null);
  const href = settingsHref(uiBase);
  const facts: SetupFacts = { ...(await companySetupFacts(env, info)), prefix: null, settingsPath: href };
  const engine = Object.fromEntries(buildSetupChecklist(facts).map((i) => [i.key, i])) as Record<string, EngineItem>;
  const sprints = await db.listSprints(env.ctx.db, companyId).catch(() => [] as db.Sprint[]);
  const running = sprints.filter((s) => isRunning(s.status));

  const items: SetupItem[] = [];
  items.push({ ...settingsItem({ saved: facts.settingsSaved, pluginId: installationId(uiBase) ?? "", detail: engine.settings!.detail, agentNext: engine.settings!.next }), href });

  const sa = fromEngine(engine.service_account!, { required: true, title: "Add the Google service account key" });
  items.push(sa);
  items.push(apiItem(sa.status === "done", sa.status === "done" ? await probeApis(env, info).catch((error: unknown) => ({ error: errorMessage(error) })) : null));

  items.push({
    key: "first_sprint",
    title: "Create the first SEO sprint",
    status: sprints.length > 0 ? "done" : "missing",
    required: true,
    detail: sprints.length > 0
      ? `${sprints.length} sprint${sprints.length === 1 ? "" : "s"} (${running.length} running).`
      : "No sprint yet. A sprint is one site's 90-day plan, worked by the SEO agent.",
    href: "/seo",
    hrefLabel: "Open SEO",
    steps: sprints.length > 0 ? undefined : [
      "Open SEO and click **New sprint**.",
      "Enter the site URL and name; pick own site or a CRM client.",
      "Click **Start the 90-day plan**.",
    ],
    agentNext: "Opens the week's tasks as issues and works them every day.",
  });

  const perSprint = await Promise.all(running.map(async (sprint) => {
    const list = buildSetupChecklist({ ...facts, sprint: await sprintSetupFacts(env, sprint) });
    return { sprint, list: Object.fromEntries(list.map((i) => [i.key, i])) as Record<string, EngineItem> };
  }));
  const pick = (key: string) => perSprint.map(({ sprint, list }) => ({ sprint, item: list[key]! })).filter((r) => r.item);
  const noSprint = (key: string, title: string, required: boolean, detail: string): SetupItem => ({
    key,
    title,
    status: "blocked",
    required,
    detail,
    href: "/seo",
    hrefLabel: "Open SEO",
    blockedBy: ["first_sprint"],
    agentNext: null,
  });

  items.push(running.length
    ? sprintAggregate("site_project", pick("site_project"), { title: "Link each site's repo project", required: true, tab: "integrations" })
    : noSprint("site_project", "Link each site's repo project", true, "Linked per sprint once a sprint is running."));

  items.push({
    ...fromEngine(engine.github_token!, { required: false, title: "Give the agent GitHub access" }),
    status: "unknown",
    href: GITHUB_PAT_URL,
    hrefLabel: "New GitHub token",
    steps: githubTokenSteps(null, running.find((s) => s.repoUrl)?.repoUrl ?? null),
  });

  items.push(fromEngine(engine.bing_key!, { required: true, title: "Add the Bing Webmaster API key" }));
  items.push(fromEngine(engine.pagespeed_key!, { required: false, warnIs: "optional", title: "Add a PageSpeed API key" }));

  const agentItem = fromEngine(engine.agent!, { required: true, title: "Hire or link the SEO agent" });
  items.push({
    ...agentItem,
    href: facts.agent ? `/agents/${facts.agent.id}` : "/seo",
    hrefLabel: facts.agent ? "Open the agent" : "Open SEO",
    action: facts.agent ? null : { plugin: PLUGIN_ID, key: "seo.start-hire", params: {}, label: "Open a hire task" },
  });

  items.push(running.length
    ? sprintAggregate("autopilot", pick("autopilot"), { title: "Set autopilot to safe", required: true, warnIs: "done" })
    : noSprint("autopilot", "Set autopilot to safe", true, "Set per sprint once a sprint is running."));
  if (running.length) {
    items.push(sprintAggregate("gsc_property", pick("gsc_property"), { title: "Search Console property connected", required: false, tab: "integrations" }));
    items.push(sprintAggregate("bing_site", pick("bing_site"), { title: "Bing site verified", required: false, tab: "integrations" }));
  }

  return { plugin: PLUGIN_ID, module: "seo", title: "SEO", version: manifest.version, items, checkedAt: env.now().toISOString() };
}

/** Companies with sprints plus companies whose SEO settings were saved. */
export async function seoCompanies(env: Env): Promise<string[]> {
  const companies = new Set<string>();
  try {
    for (const id of await db.listSprintCompanies(env.ctx.db)) companies.add(id);
  } catch (error) {
    env.ctx.logger.info("SEO companies: sprint companies unavailable", { error: errorMessage(error) });
  }
  try {
    for (const company of await env.ctx.companies.list({ limit: 100 })) {
      if (!companies.has(company.id) && (await configSaved(env.ctx, company.id))) companies.add(company.id);
    }
  } catch (error) {
    env.ctx.logger.info("SEO companies: company list unavailable", { error: errorMessage(error) });
  }
  return [...companies];
}

/** Hourly: push each company's checklist to the Setup plugin (module on, settings saved). */
export async function publishSetupStatuses(env: Env, companies?: string[]): Promise<{ published: number; skipped: number }> {
  const result = { published: 0, skipped: 0 };
  for (const companyId of companies ?? (await seoCompanies(env))) {
    try {
      if (!(await seoOn(env, companyId)) || !(await configSaved(env.ctx, companyId))) {
        result.skipped += 1;
        continue;
      }
      await publishSetupStatus(env.ctx, companyId, await seoSetupStatus(env, companyId));
      result.published += 1;
    } catch (error) {
      result.skipped += 1;
      env.ctx.logger.info("SEO setup status skipped", { companyId, error: errorMessage(error) });
    }
  }
  return result;
}
