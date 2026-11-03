/**
 * Cockpit → Browser tab data: the pib-browser logins as the status file reports them (no secret, no page body).
 * Owner company only, like the credential rows built from the same file.
 */
import type { PluginPerformActionContext } from "@paperclipai/plugin-sdk";
import { isOwnerCompany } from "@partnersinbiz/pib-plugin-kit";
import { BROWSER_STATUS_PATH, readStatus } from "./credentials.js";
import { parseBrowserStatus, type BrowserIdentity } from "./credentials-model.js";
import { CockpitError, type Env } from "./env.js";

export interface BrowserView {
  /** `unavailable`: not the owner company, which has no browser. `missing`/`invalid`: the file is absent or unreadable ("unverified", not "expired"). */
  state: "unavailable" | "missing" | "invalid" | "read";
  checkedAt: string | null;
  stale: boolean;
  identities: BrowserIdentity[];
}

export async function loadBrowserView(env: Env, context: PluginPerformActionContext): Promise<BrowserView> {
  if (!context.companyId) throw new CockpitError("Company is required");
  if (!(await isOwnerCompany(env.ctx, context.companyId))) return { state: "unavailable", checkedAt: null, stale: false, identities: [] };
  const status = parseBrowserStatus(await readStatus(env, process.env.PIB_BROWSER_STATUS || BROWSER_STATUS_PATH), env.now());
  if (status.state !== "read") return { state: status.state, checkedAt: null, stale: false, identities: [] };
  return { state: "read", checkedAt: status.checkedAt, stale: status.stale, identities: status.identities };
}

export function registerBrowserStatus(env: Env): void {
  env.ctx.actions.register("browser.status", async (_params, context) => loadBrowserView(env, context));
}
