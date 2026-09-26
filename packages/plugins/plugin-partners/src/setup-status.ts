/**
 * What Partners still needs for a company, for the Setup plugin's checklist
 * (`GET /setup-status` and the hourly `setup.status` event). Partners is an
 * optional module, so the list stays short.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import {
  moduleOfPlugin,
  pluginUiBase,
  publishSetupStatus,
  readConfig,
  settingsItem,
  type SetupItem,
  type SetupStatus,
} from "@partnersinbiz/pib-plugin-kit";
import { PLUGIN_ID, PLUGIN_VERSION } from "./namespace.js";

const SETTINGS_FALLBACK = "/company/settings/instance/plugins";
const KNOWN = { scopeKind: "instance" as const, namespace: "partners-setup", stateKey: "known-companies" };

export async function settingsHref(ctx: PluginContext): Promise<{ href: string; uuid: string | null }> {
  const base = await pluginUiBase(ctx);
  const uuid = base ? /^\/_plugins\/([0-9a-f-]{36})\/ui\/$/.exec(base)?.[1] ?? null : null;
  return { href: uuid ? `${SETTINGS_FALLBACK}/${uuid}` : SETTINGS_FALLBACK, uuid };
}

function table(ctx: PluginContext, name: string): string {
  if (!/^plugin_[a-z0-9_]+$/.test(ctx.db.namespace) || !/^[a-z_]+$/.test(name)) throw new Error("Unsafe identifier");
  return `${ctx.db.namespace}.${name}`;
}

export async function rememberCompany(ctx: PluginContext, companyId: string): Promise<void> {
  try {
    const known = asList(await ctx.state.get(KNOWN));
    if (known.includes(companyId)) return;
    await ctx.state.set(KNOWN, [...known, companyId]);
  } catch {
    // best effort
  }
}

/** Companies on a link, plus companies that opened the Partners page. */
export async function knownCompanies(ctx: PluginContext): Promise<string[]> {
  const ids: string[] = [];
  try {
    const rows = await ctx.db.query<{ company_a_id: string; company_b_id: string }>(`SELECT company_a_id, company_b_id FROM ${table(ctx, "links")}`);
    for (const row of rows) ids.push(row.company_a_id, row.company_b_id);
  } catch {
    // no rows yet
  }
  try {
    ids.push(...asList(await ctx.state.get(KNOWN)));
  } catch {
    // ignore
  }
  return [...new Set(ids.filter(Boolean))];
}

function asList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
}

export async function setupStatus(ctx: PluginContext, companyId: string): Promise<SetupStatus> {
  let saved = false;
  try {
    saved = Object.keys(await readConfig(ctx, companyId)).length > 0;
  } catch {
    saved = false;
  }
  const { href, uuid } = await settingsHref(ctx);
  const items: SetupItem[] = [];
  items.push({
    ...settingsItem({ saved, pluginId: uuid ?? "", title: "Save the Partners settings", agentNext: "Partner links and record grants work for this company." }),
    href,
  });

  let active = 0;
  try {
    const rows = await ctx.db.query<{ id: string }>(
      `SELECT id FROM ${table(ctx, "links")} WHERE status = 'active' AND (company_a_id = $1 OR company_b_id = $1)`,
      [companyId],
    );
    active = rows.length;
  } catch {
    active = 0;
  }
  items.push({
    key: "link",
    title: "Link a partner company",
    status: active > 0 ? "done" : "optional",
    required: false,
    detail: active > 0 ? `${active} active partner link${active === 1 ? "" : "s"}.` : "Optional. Only needed when you share records with another Paperclip company.",
    href: "/partners",
    hrefLabel: "Open Partners",
    steps: active > 0 ? undefined : ["Open Partners.", "Click + Propose link and enter the other company's Paperclip id.", "Ask the other company to accept the link."],
    agentNext: null,
  });

  return {
    plugin: PLUGIN_ID,
    module: moduleOfPlugin(PLUGIN_ID),
    title: "Partners",
    version: PLUGIN_VERSION,
    items,
    checkedAt: new Date().toISOString(),
  };
}

export async function publishAllSetupStatus(ctx: PluginContext): Promise<number> {
  let published = 0;
  for (const companyId of await knownCompanies(ctx)) {
    try {
      if (Object.keys(await readConfig(ctx, companyId)).length === 0) continue;
      await publishSetupStatus(ctx, companyId, await setupStatus(ctx, companyId));
      published += 1;
    } catch (error) {
      ctx.logger.info("Partners setup status skipped", { companyId, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return published;
}
