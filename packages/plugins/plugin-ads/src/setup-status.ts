/**
 * Guided setup for the Setup plugin: what this company still needs before paid-ads reporting and governed changes work. Served at
 * GET /setup-status and pushed hourly as `setup.status` (kit `publishSetupStatus`). Read-only: never creates an account, agent or connection.
 *
 * The provider boundary: nothing here creates an account or enters a credential. Each platform item lists the exact steps a person does once,
 * with deep links and honest lead times; the plugin does the rest once the keys exist.
 *
 * Until the company has saved the plugin's settings, the plugin is simply off and the only item is optional, so a company that does not run
 * ads never sees a "steps left" count from it.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { teamSetupPath } from "@partnersinbiz/pib-plugin-kit/team";
import { hireStatus, pluginUiBase, settingsItem, moduleOfPlugin, type SetupItem, type SetupStatus } from "@partnersinbiz/pib-plugin-kit";
import { loadAdsConfig, type AdsConfig } from "./config.js";
import { listAccounts, listConnections, listScopes } from "./db.js";
import { errorMessage } from "./domain.js";
import { ADS_AGENT_NAME, ADS_MATCH_ROLE } from "./hire.js";
import { ADS_ROLE_KEY, PLUGIN_ID, PLUGIN_VERSION } from "./platforms.js";
import type { TeamRoleKey } from "@partnersinbiz/pib-plugin-kit";

const PLUGINS_PATH = "/company/settings/instance/plugins";

function installationId(uiBase: string | null): string | null {
  return uiBase ? /\/_plugins\/([^/]+)\//.exec(uiBase)?.[1] ?? null : null;
}

function settingsHref(uiBase: string | null): string {
  const id = installationId(uiBase);
  return id ? `${PLUGINS_PATH}/${id}` : PLUGINS_PATH;
}

async function attempt<T>(ctx: PluginContext, what: string, run: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    ctx.logger.info(`Ads setup check skipped: ${what}`, { error: errorMessage(error) });
    return { ok: false, error: errorMessage(error) };
  }
}

function redirectText(config: AdsConfig): string {
  try {
    return config.redirectUri();
  } catch {
    return "(save the public base URL in the plugin settings, then open the Ads page once: it shows the exact address)";
  }
}

export function metaSteps(config: AdsConfig): string[] {
  return [
    "Open Meta for Developers (https://developers.facebook.com/apps) and create an app of type Business inside the business that owns the ad accounts, or open the one you have.",
    "Add the Marketing API product to the app. Reading needs the ads_read permission. Changing ads needs ads_management: leave changes off for now, you can ask for it later.",
    "Your own ad account works at once with standard access (the people who have a role on the app). Other businesses' ad accounts need Advanced access: submit App Review for ads_read (and ads_management if changes will ever be wanted) with a short screen recording of what the plugin does. Meta states no review time: plan one to two weeks, longer if Business Verification (https://business.facebook.com/settings/security) is asked for first.",
    "No review needed instead: the client shares the ad account with your business as a partner (Business Settings -> Accounts -> Ad accounts -> Partners), you create a system user (Business Settings -> Users -> System users), assign the ad account to it, and generate a token with ads_read. Paste that token below instead of the app.",
    `In the app's Facebook Login settings, add this redirect URI: ${redirectText(config)}`,
    "Open this plugin's settings -> Platforms -> Meta: paste the app ID and the app secret (as a Paperclip secret), or the system-user token (as a secret), switch Meta on, and Save Configuration.",
    "Open Ads -> Accounts and click Connect Meta (or Connect with the saved token). Pick the ad accounts to read.",
  ];
}

export function googleSteps(config: AdsConfig): string[] {
  return [
    "Open the Google Cloud console (https://console.cloud.google.com/), pick or create a project for Paperclip and enable the Google Ads API (https://console.cloud.google.com/apis/library/googleads.googleapis.com).",
    "APIs and Services -> OAuth consent screen. If the Google account that will sign in belongs to your Google Workspace organisation, choose user type Internal (no verification, and the sign-in does not expire). For an account outside your organisation choose External and publish the app: an app left in Testing gets refresh tokens that expire after 7 days, and publishing an app that asks for the Google Ads scope needs Google's verification (Google states no fixed time).",
    "APIs and Services -> Credentials -> Create credentials -> OAuth client ID -> Web application. Add this authorised redirect URI: " + redirectText(config),
    "Access level: since 2026-09-09 Google Ads API access belongs to the Cloud project that owns the OAuth client (developer tokens are no longer issued). Open the project's Google Ads API overview page in the Cloud console and apply for Basic access (15,000 operations a day, enough here). Google requires brand verification of the app first and then reviews a Basic application automatically within minutes; Google publishes no time for brand verification, so allow a few business days.",
    "Open this plugin's settings -> Platforms -> Google Ads: paste the OAuth client ID and the client secret (as a Paperclip secret), switch Google Ads on, and Save Configuration.",
    "Open Ads -> Accounts and click Connect Google Ads and sign in with the account that can see the ad accounts (a manager account shows all its client accounts). Pick the ad accounts to read.",
  ];
}

export async function adsSetupStatus(ctx: PluginContext, companyId: string, now = new Date()): Promise<SetupStatus> {
  const config = await loadAdsConfig(ctx, companyId);
  const uiBase = await pluginUiBase(ctx).catch(() => null);
  const href = settingsHref(uiBase);
  const base = { plugin: PLUGIN_ID, module: moduleOfPlugin(PLUGIN_ID), title: "Paid ads", version: PLUGIN_VERSION, checkedAt: now.toISOString() };

  // Not set up for this company: the plugin is off. One optional item says how to start; nothing is "left to do".
  if (!config.saved) {
    return {
      ...base,
      items: [
        {
          ...settingsItem({
            saved: false,
            pluginId: installationId(uiBase) ?? "",
            title: "Paid ads (optional)",
            detail: "Optional. Reads Meta and Google ad performance into one picture, watches budgets, and turns campaign and budget changes into approved proposals. Off until you save its settings.",
            agentNext: "The sync, token and alert jobs start for this company and the Setup checklist below appears.",
          }),
          required: false,
          href,
        },
      ],
    };
  }

  const connections = await attempt(ctx, "connections", () => listConnections(ctx, companyId));
  const accounts = await attempt(ctx, "accounts", () => listAccounts(ctx, companyId));
  const scopes = await attempt(ctx, "scopes", () => listScopes(ctx, companyId));
  const items: SetupItem[] = [];

  items.push({ ...settingsItem({ saved: true, pluginId: installationId(uiBase) ?? "" }), href });

  const missingBase: string[] = [];
  if (!config.publicBaseUrl) missingBase.push(config.publicBaseUrlError ?? "the public base URL");
  if (!config.encryptionKeyConfigured) missingBase.push("the token encryption key");
  items.push({
    key: "base_url_key",
    title: "Set the public base URL and token encryption key",
    status: missingBase.length === 0 ? "done" : "missing",
    required: true,
    detail: missingBase.length === 0 ? `Public base URL: ${config.publicBaseUrl}. Sign-in tokens are encrypted with the key.` : `Missing: ${missingBase.join("; ")}. Sign-ins need the base URL, and tokens cannot be stored without the key.`,
    href,
    hrefLabel: "Open settings",
    steps: missingBase.length === 0 ? undefined : [
      "Open the Paid ads plugin settings.",
      "Public base URL: the address people use to open Paperclip, e.g. https://paperclip.partnersinbiz.online.",
      "Token encryption key: create a Paperclip secret with a long random value (at least 16 characters) and pick it.",
      "Click Save Configuration.",
    ],
    agentNext: "An ad platform can be connected.",
  });

  const metaState = config.platform("meta");
  const googleState = config.platform("google");
  const live = connections.ok ? connections.value.filter((c) => c.status === "connected" || c.status === "expiring") : [];
  const connectedOf = (platform: string) => live.filter((c) => c.platform === platform).length;
  const platformItem = (key: string, title: string, platform: "meta" | "google", steps: string[], consoleUrl: string, state: ReturnType<AdsConfig["platform"]>): SetupItem => {
    const n = connectedOf(platform);
    return {
      key,
      title,
      required: false,
      status: n > 0 ? "done" : state.enabled ? "missing" : "optional",
      detail:
        n > 0
          ? `${n} sign-in${n === 1 ? "" : "s"} connected.`
          : state.enabled
            ? `Switched on and keys saved. Open Ads -> Accounts and connect it.`
            : state.switchedOn
              ? (state.blocker ?? "Switched on but not complete.")
              : "Optional: use only the platforms you advertise on. Off until you do the steps below.",
      href: n > 0 || state.enabled ? "/ads?tab=accounts" : consoleUrl,
      hrefLabel: n > 0 || state.enabled ? "Open Ads accounts" : platform === "meta" ? "Open Meta for Developers" : "Open Google Cloud",
      steps: n > 0 ? undefined : steps,
      agentNext: "The plugin reads campaigns and daily numbers every 3 hours, builds the spend ledger and raises alerts. It never changes anything.",
    };
  };
  items.push(platformItem("platform_meta", "Meta ads (Facebook and Instagram)", "meta", metaSteps(config), "https://developers.facebook.com/apps", metaState));
  items.push(platformItem("platform_google", "Google Ads", "google", googleSteps(config), "https://console.cloud.google.com/apis/library/googleads.googleapis.com", googleState));

  const anyLive = live.some((c) => c.platform !== "mock");
  items.push({
    key: "platform_connected",
    title: "Connect at least one ad platform",
    status: !connections.ok ? "unknown" : anyLive ? "done" : "missing",
    required: true,
    detail: !connections.ok ? `Could not read connections: ${connections.error}` : anyLive ? `${live.filter((c) => c.platform !== "mock").length} connected.` : "Meta or Google, using the platform items below. Signing in is a one-time grant only a person can give.",
    href: "/ads?tab=accounts",
    hrefLabel: "Open Ads accounts",
    steps: anyLive ? undefined : ["Do the steps of the platform you advertise on (the items below).", "Open Ads -> Accounts and click Connect."],
    agentNext: "Ad accounts can be registered.",
  });

  const registered = accounts.ok ? accounts.value.filter((a) => a.status === "active") : [];
  items.push({
    key: "ad_accounts",
    title: "Register at least one ad account",
    status: !accounts.ok ? "unknown" : registered.length > 0 ? "done" : !anyLive ? "blocked" : "missing",
    required: true,
    detail: !accounts.ok ? `Could not read accounts: ${accounts.error}` : registered.length > 0 ? `${registered.length} registered: ${registered.slice(0, 4).map((a) => a.name).join(", ")}${registered.length > 4 ? ", ..." : ""}.` : "Each ad account belongs to PiB's own ads or to one client. The ads agent can do this once a platform is connected.",
    href: "/ads?tab=accounts",
    hrefLabel: "Open Ads accounts",
    steps: registered.length > 0 ? undefined : ["Open Ads -> Accounts.", "Under a connection, click Add next to an ad account and choose whose it is: PiB's own, or a client."],
    ...(anyLive ? {} : { blockedBy: ["platform_connected"] }),
    agentNext: "The first sync reads the last 30 days; alerts and budget pacing start.",
  });

  const live_ = scopes.ok ? scopes.value.filter((s) => registered.some((a) => a.scope_key === s.scope_key)) : [];
  const noCap = live_.filter((s) => s.monthly_cap_minor === null);
  items.push({
    key: "budget_caps",
    title: "Set a monthly budget cap for every scope",
    status: !scopes.ok ? "unknown" : registered.length === 0 ? "blocked" : noCap.length === 0 ? "done" : "missing",
    required: true,
    detail: !scopes.ok ? `Could not read scopes: ${scopes.error}` : registered.length === 0 ? "Waits for an ad account." : noCap.length === 0 ? "Every scope with an ad account has a cap." : `${noCap.length} scope${noCap.length === 1 ? " has" : "s have"} no cap: ${noCap.slice(0, 4).map((s) => (s.scope_key === "own" ? "PiB's own ads" : s.scope_key)).join(", ")}. Without one the budget alerts cannot fire and no change that adds spend can run.`,
    href: "/ads?tab=budgets",
    hrefLabel: "Open Ads budgets",
    steps: noCap.length === 0 ? undefined : ["Open Ads -> Budgets.", "Enter the most each scope may spend this month, in its currency, and Save.", "The alert point defaults to 90%: at that point the plugin asks a person to pause (it never pauses by itself)."],
    ...(registered.length === 0 ? { blockedBy: ["ad_accounts"] } : {}),
    agentNext: "Pacing shows on the page and in the Cockpit, and at the alert point a pause request opens for a person to decide.",
  });

  const hire = await attempt(ctx, "agent", () => hireStatus(ctx, companyId, ADS_MATCH_ROLE));
  const agent = hire.ok ? hire.value.agent : null;
  const openHire = hire.ok && hire.value.hire?.status === "open" ? hire.value.hire : null;
  items.push({
    key: "agent",
    title: "Hire or link the Paid Ads Manager",
    status: !hire.ok ? "unknown" : agent ? "done" : "missing",
    required: true,
    detail: !hire.ok
      ? `Could not check the agent: ${hire.error}`
      : agent
        ? `${agent.name || ADS_AGENT_NAME} is the ads agent (${agent.status}).`
        : openHire
          ? `The hire task ${openHire.identifier ?? openHire.title} is open. The agent is linked once it appears, or pick one in Setup -> Team.`
          : `No ${ADS_AGENT_NAME} yet. A hire task asks your hiring agent (or a person) to create one; the plugin links and wires it.`,
    href: teamSetupPath(ADS_ROLE_KEY as TeamRoleKey),
    hrefLabel: "Open Team in Setup",
    steps: agent ? undefined : ["Open Setup -> Team -> Paid Ads Manager.", "Hire one (a hire task for your hiring agent or a person), or pick an agent you already have.", "Approve and resume the new agent once it exists."],
    action: !agent && !openHire && hire.ok ? { plugin: PLUGIN_ID, key: "ads.start-hire", params: {}, label: "Open a hire task" } : null,
    agentNext: "The agent gets the ads tools, watches alerts, and prepares campaign and budget proposals. It cannot approve or spend.",
  });

  const writeScopes = scopes.ok ? scopes.value.filter((s) => s.allow_writes).length : 0;
  items.push({
    key: "writes",
    title: "Let approved changes run (optional)",
    status: config.writesEnabled && writeScopes > 0 ? "done" : "optional",
    required: false,
    detail: config.writesEnabled && writeScopes > 0
      ? `Changes are on for ${writeScopes} scope${writeScopes === 1 ? "" : "s"}. Every change still needs a recorded approval and stays inside the cap.`
      : "Optional and off by default. Until then the plugin only reads and proposes; after a person approves a change, a person makes it in the ad platform and marks it done. To let the agent run approved changes: switch it on in the settings (Changing ads), give the connection the change permission (Meta: ads_management; Google: its own switch, since Google has one permission for reading and changing), and switch it on per scope on the Ads page.",
    href,
    hrefLabel: "Open settings",
    steps: config.writesEnabled && writeScopes > 0 ? undefined : [
      "Open this plugin's settings -> Changing ads: switch on Allow changes to ads at all, and Save.",
      "Meta: also tick The connection may change ads and connect again (it asks for ads_management; standard access works for your own account, other businesses need App Review for it).",
      "Google: also tick The connection may change ads and connect again (Google's one sign-in permission reads and changes; this switch is what keeps the connection read-only until you want otherwise).",
      "Open Ads -> Budgets and switch Allow changes on for each scope you trust the process for (a cap must be set first).",
    ],
    agentNext: "After a person approves a change, the agent runs it with the approval id; the plugin re-checks everything and refuses with a reason when something is off.",
  });

  return { ...base, items };
}
