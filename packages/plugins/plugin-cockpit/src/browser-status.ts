/**
 * Cockpit → Browser tab data: the pib-browser logins as the status file reports them (no secret, no page body).
 * Owner company only, like the credential rows built from the same file.
 */
import type { PluginPerformActionContext } from "@paperclipai/plugin-sdk";
import { isOwnerCompany, type AccessGuard } from "@partnersinbiz/pib-plugin-kit";
import { BROWSER_STATUS_PATH, readStatus } from "./credentials.js";
import { parseBrowserStatus, type BrowserIdentity } from "./credentials-model.js";
import { browserLiveFor, type BrowserLiveSetting } from "./browser-live.js";
import { CockpitError, type Env } from "./env.js";

export interface BrowserView {
  /** `unavailable`: not the owner company, which has no browser. `missing`/`invalid`: the file is absent or unreadable ("unverified", not "expired"). */
  state: "unavailable" | "missing" | "invalid" | "read";
  checkedAt: string | null;
  stale: boolean;
  identities: BrowserIdentity[];
  /** The `browserLive` setting when the caller may watch (signed-in owner or admin), else `off`. Drives "Watch live". */
  live: BrowserLiveSetting;
}

export async function loadBrowserView(env: Env, context: PluginPerformActionContext): Promise<BrowserView> {
  if (!context.companyId) throw new CockpitError("Company is required");
  if (!(await isOwnerCompany(env.ctx, context.companyId))) return { state: "unavailable", checkedAt: null, stale: false, identities: [], live: "off" };
  // Watch live does not depend on the status file: a missing file is the very case a person wants to look at.
  const live = await browserLiveFor(env, context);
  const status = parseBrowserStatus(await readStatus(env, process.env.PIB_BROWSER_STATUS || BROWSER_STATUS_PATH), env.now());
  if (status.state !== "read") return { state: status.state, checkedAt: null, stale: false, identities: [], live };
  return { state: "read", checkedAt: status.checkedAt, stale: status.stale, identities: status.identities, live };
}

export function registerBrowserStatus(env: Env, guard: AccessGuard): void {
  guard.action("browser.status", async (_params, context) => loadBrowserView(env, context));
}
