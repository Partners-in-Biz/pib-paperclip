/**
 * Guided setup for the Setup plugin: what this company still needs before
 * the Social agent can run on its own. Served at GET /setup-status and
 * pushed hourly as `setup.status` (kit `publishSetupStatus`).
 *
 * Read-only: never creates a program, agent or routine.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { hireStatus, pluginUiBase, settingsItem, type SetupItem, type SetupStatus } from "@partnersinbiz/pib-plugin-kit";
import { loadSocialConfig, type SocialConfig } from "./config.js";
import { listAccounts } from "./db.js";
import { GROWTH_CHANNEL } from "./growth/engine.js";
import { sqlGrowthStore } from "./growth/sql.js";
import { legacySocialAgent, SOCIAL_AGENT_NAME, SOCIAL_HIRE_ROLE } from "./hire.js";
import manifest from "./manifest.js";
import { ALL_PLATFORMS, NEEDS_APP_CREDENTIALS, PLAN_ROUTINE_KEY, PLATFORM_LABELS, PLUGIN_ID, type SocialPlatform } from "./platforms.js";
import { PLAN_ROUTINE_TITLE } from "./skills.js";
import { jevKeySet } from "./triage.js";

const PLUGINS_PATH = "/company/settings/instance/plugins";

/** Where each provider's developer app lives. */
export const APP_CONSOLES: Partial<Record<SocialPlatform, string>> = {
  facebook: "https://developers.facebook.com/apps",
  instagram: "https://developers.facebook.com/apps",
  threads: "https://developers.facebook.com/apps",
  linkedin: "https://www.linkedin.com/developers/apps",
  x: "https://developer.x.com/en/portal/dashboard",
  tiktok: "https://developers.tiktok.com/apps",
  youtube: "https://console.cloud.google.com/apis/credentials",
  pinterest: "https://developers.pinterest.com/apps/",
  reddit: "https://www.reddit.com/prefs/apps",
  dribbble: "https://dribbble.com/account/applications",
};

export const APP_PLATFORMS = ALL_PLATFORMS.filter((p) => NEEDS_APP_CREDENTIALS[p]);

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function attempt<T>(ctx: PluginContext, what: string, run: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    ctx.logger.info(`Social setup check skipped: ${what}`, { error: errorMessage(error) });
    return { ok: false, error: errorMessage(error) };
  }
}

function installationId(uiBase: string | null): string | null {
  return uiBase ? /\/_plugins\/([^/]+)\//.exec(uiBase)?.[1] ?? null : null;
}

function settingsHref(uiBase: string | null): string {
  const id = installationId(uiBase);
  return id ? `${PLUGINS_PATH}/${id}` : PLUGINS_PATH;
}

function settingsSteps(fields: string[]): string[] {
  return ["Open the Social plugin settings.", ...fields, "Click Save Configuration."];
}

export function baseItems(config: SocialConfig, uiBase: string | null): SetupItem[] {
  const href = settingsHref(uiBase);
  const settings = { ...settingsItem({ saved: config.saved, pluginId: installationId(uiBase) ?? "", agentNext: "The publish, token and inbox jobs start acting for this company." }), href };

  const missingBase: string[] = [];
  if (!config.publicBaseUrl) missingBase.push(config.publicBaseUrlError ?? "the public base URL");
  if (!config.encryptionKeyConfigured) missingBase.push("the token encryption key");
  const baseKey: SetupItem = {
    key: "base_url_key",
    title: "Set the public base URL and token encryption key",
    status: missingBase.length === 0 ? "done" : "missing",
    required: true,
    detail: missingBase.length === 0
      ? `Public base URL: ${config.publicBaseUrl}. Account tokens are encrypted with the key.`
      : `Missing: ${missingBase.join("; ")}. OAuth redirects need the base URL, and accounts cannot be stored without the key.`,
    href,
    hrefLabel: "Open settings",
    steps: missingBase.length === 0 ? undefined : settingsSteps([
      "Public base URL: the address people use to open Paperclip, e.g. https://paperclip.partnersinbiz.online.",
      "Token encryption key: create a Paperclip secret with a long random value (at least 16 characters) and pick it.",
    ]),
    agentNext: "Accounts can be connected.",
  };

  const r2: SetupItem = {
    key: "r2",
    title: "Connect Cloudflare R2 media storage",
    status: config.r2Configured ? "done" : "missing",
    required: true,
    detail: config.r2Configured
      ? "Images and videos upload to the R2 bucket and platforms read them from its public URL."
      : "Posts with images or video need a public R2 bucket (Instagram and TikTok always do).",
    href,
    hrefLabel: "Open settings",
    steps: config.r2Configured ? undefined : [
      "In Cloudflare, open R2 and create a bucket for social media.",
      "Give the bucket a public custom domain (e.g. media.partnersinbiz.online).",
      "Create an R2 API token with Object Read & Write on that bucket.",
      "Store the secret access key as a Paperclip secret.",
      ...settingsSteps(["Under Cloudflare R2 media, fill in the account ID, bucket, access key ID, secret access key and public media URL (https://)."]),
    ],
    agentNext: "The agent can attach images and video to posts.",
  };
  return [settings, baseKey, r2];
}

export function appItems(config: SocialConfig, uiBase: string | null, connectedNoAppPlatforms: string[]): SetupItem[] {
  const href = settingsHref(uiBase);
  const statuses = APP_PLATFORMS.map((p) => config.platform(p));
  const ready = statuses.filter((s) => s.configured).map((s) => PLATFORM_LABELS[s.platform]);
  const partial = statuses.filter((s) => !s.configured && (s.clientId || s.hasSecret));
  const anyReady = ready.length > 0 || connectedNoAppPlatforms.length > 0;
  const summary: SetupItem = {
    key: "platform_apps",
    title: "Add at least one platform app",
    status: anyReady ? "done" : "missing",
    required: true,
    detail: [
      ready.length ? `Ready: ${ready.join(", ")}.` : "No platform app has a client ID and secret yet.",
      partial.length ? `Incomplete: ${partial.map((s) => `${PLATFORM_LABELS[s.platform]} (${s.clientId ? "no secret" : "no client ID"})`).join(", ")}.` : "",
      connectedNoAppPlatforms.length ? `Connected without an app: ${connectedNoAppPlatforms.join(", ")}.` : "Bluesky and Mastodon need no app.",
    ].filter(Boolean).join(" "),
    href,
    hrefLabel: "Open settings",
    steps: anyReady ? undefined : [
      "Pick the platforms you post to and create a developer app for each (links on each platform item).",
      "Register the redirect URI shown under \"Register the redirect URI\" in each app.",
      ...settingsSteps(["Under Platforms, fill in the client ID and pick the client secret (a Paperclip secret) for each app."]),
    ],
    agentNext: "Accounts on those platforms can be connected.",
  };
  const perPlatform = statuses.map((s): SetupItem => {
    const label = PLATFORM_LABELS[s.platform];
    const console = APP_CONSOLES[s.platform] ?? null;
    return {
      key: `app_${s.platform}`,
      title: `${label} app`,
      status: s.configured ? "done" : "optional",
      required: false,
      detail: s.configured ? `Client ID ${s.clientId} with a secret.` : s.clientId || s.hasSecret ? `Missing ${s.missing.join(" and ")}.` : `Only needed to post to ${label}.`,
      href: console,
      hrefLabel: console ? `${label} developer apps` : null,
      steps: s.configured ? undefined : [
        `Create an app in the ${label} developer portal${console ? ` (${console})` : ""}.`,
        "Add the redirect URI shown under \"Register the redirect URI\".",
        `In the Social plugin settings, under Platforms → ${label}, fill in the client ID and pick the client secret.`,
        "Click Save Configuration.",
      ],
      agentNext: null,
    };
  });
  return [summary, ...perPlatform];
}

export function redirectItem(config: SocialConfig, uiBase: string | null): SetupItem {
  let uri: string | null = null;
  let problem: string | null = null;
  try {
    uri = config.redirectUri();
  } catch (error) {
    problem = errorMessage(error);
  }
  return {
    key: "redirect_uri",
    title: "Register the redirect URI",
    status: uri ? "unknown" : "blocked",
    required: false,
    detail: uri
      ? `Register ${uri} as the OAuth redirect (callback) URI in every platform app. Paperclip cannot check this.`
      : problem ?? "The redirect URI is not known yet.",
    href: uri ? "/social?tab=accounts" : settingsHref(uiBase),
    hrefLabel: uri ? "Open Social accounts" : "Open settings",
    steps: uri
      ? [`Copy ${uri}.`, "Open each platform app's OAuth / login settings.", "Add it as an allowed redirect URI and save."]
      : ["Set the public base URL in the Social plugin settings.", "Open the Social page once so the callback address is known."],
    blockedBy: uri ? undefined : ["base_url_key"],
    agentNext: null,
  };
}

/** Everything a company still needs. Host calls that fail become `unknown` items. */
export async function socialSetupStatus(ctx: PluginContext, companyId: string, now = new Date()): Promise<SetupStatus> {
  const config = await loadSocialConfig(ctx, companyId);
  const uiBase = await pluginUiBase(ctx).catch(() => null);
  const items: SetupItem[] = [];

  const accounts = await attempt(ctx, "accounts", () => listAccounts(ctx, companyId, null));
  const connected = accounts.ok ? accounts.value.filter((a) => a.token_enc && (a.status === "connected" || a.status === "expiring")) : [];
  const noAppConnected = [...new Set(connected.filter((a) => a.platform === "bluesky" || a.platform === "mastodon").map((a) => PLATFORM_LABELS[a.platform as SocialPlatform] ?? a.platform))];

  const base = baseItems(config, uiBase);
  const apps = appItems(config, uiBase, noAppConnected);
  items.push(...base, apps[0]!, redirectItem(config, uiBase));

  const baseDone = base[1]!.status === "done";
  const appsDone = apps[0]!.status === "done";
  const needsReconnect = accounts.ok ? accounts.value.filter((a) => a.status === "needs_reconnect").length : 0;
  items.push({
    key: "own_accounts",
    title: "Connect at least one own account",
    status: !accounts.ok ? "unknown" : connected.length > 0 ? "done" : !baseDone || !appsDone ? "blocked" : "missing",
    required: true,
    detail: !accounts.ok
      ? `Could not read accounts: ${accounts.error}`
      : connected.length > 0
        ? `${connected.length} connected: ${connected.slice(0, 6).map((a) => `${PLATFORM_LABELS[a.platform as SocialPlatform] ?? a.platform} · ${a.display_name}`).join(", ")}${connected.length > 6 ? ", …" : ""}.${needsReconnect ? ` ${needsReconnect} need reconnecting.` : ""}`
        : "Partners in Biz's own pages and profiles. Client accounts are connected in each client's workspace.",
    href: "/social?tab=accounts",
    hrefLabel: "Open Social accounts",
    steps: connected.length > 0 ? undefined : [
      "Open Social → Accounts.",
      "Click Connect on a platform and sign in with the account that manages the page.",
      "Pick the pages or profiles to add.",
    ],
    blockedBy: [...(!baseDone ? ["base_url_key"] : []), ...(!appsDone ? ["platform_apps"] : [])],
    agentNext: "The agent drafts posts for these accounts and works their inbox.",
  });

  const hire = await attempt(ctx, "agent", () => hireStatus(ctx, companyId, SOCIAL_HIRE_ROLE, legacySocialAgent(ctx)));
  const agent = hire.ok ? hire.value.agent : null;
  const openHire = hire.ok && hire.value.hire?.status === "open" ? hire.value.hire : null;
  items.push({
    key: "agent",
    title: "Hire or link the Social agent",
    status: !hire.ok ? "unknown" : agent ? "done" : "missing",
    required: true,
    detail: !hire.ok
      ? `Could not check the agent: ${hire.error}`
      : agent
        ? `${agent.name || SOCIAL_AGENT_NAME} is the Social agent (${agent.status}).`
        : openHire
          ? `The hire task ${openHire.identifier ?? openHire.title} is open. The agent is linked once it appears, or link one on the Social page.`
          : `No ${SOCIAL_AGENT_NAME} yet. A hire task asks your hiring agent (or a person) to create one; the plugin links and wires it.`,
    href: "/social",
    hrefLabel: "Open Social",
    steps: agent ? undefined : [
      "Open Social and click \"Hire Social agent\" (or \"Use an existing agent\").",
      "Assign the hire task to your hiring agent or a person.",
      "Approve and resume the new agent once it exists.",
    ],
    action: !agent && !openHire && hire.ok ? { plugin: PLUGIN_ID, key: "social.start-hire", params: {}, label: "Open a hire task" } : null,
    agentNext: "The agent gets the Social tools, the weekly routine and failed-post issues.",
  });

  const routine = await attempt(ctx, "routine", () => ctx.routines.managed.get(PLAN_ROUTINE_KEY, companyId));
  const r = routine.ok ? routine.value.routine : null;
  const active = r?.status === "active";
  items.push({
    key: "routine",
    title: `Turn on the weekly "${PLAN_ROUTINE_TITLE}" routine`,
    status: !routine.ok ? "unknown" : active ? "done" : !agent && !r ? "blocked" : "missing",
    required: true,
    detail: !routine.ok
      ? `Could not check the routine: ${routine.error}`
      : !r
        ? "Created when the Social agent is linked."
        : active
          ? `Active${r.assigneeAgentId ? "" : " but not assigned to an agent"}. Make sure its Monday 07:00 trigger is enabled.`
          : `The routine is ${r.status}. The agent plans next week's posts every Monday once it is active.`,
    href: r ? `/routines/${r.id}` : "/routines",
    hrefLabel: "Open the routine",
    steps: active ? undefined : [
      "Open Routines and pick \"" + PLAN_ROUTINE_TITLE + "\".",
      "Set it to active and enable the Monday 07:00 trigger.",
    ],
    blockedBy: !agent && !r ? ["agent"] : undefined,
    agentNext: "Every Monday the agent reviews performance and drafts next week's posts for approval.",
  });

  const jev = jevKeySet(config.raw);
  items.push({
    key: "jev",
    title: "Add a Jev key",
    status: jev ? "done" : "optional",
    required: false,
    detail: jev ? "Inbox items are triaged and Growth Lab posts are tagged by Jev." : "Optional. With a Jev key, inbox items are triaged (spam, questions, escalations) and Growth Lab tags post features. Without it, built-in rules are used.",
    href: settingsHref(uiBase),
    hrefLabel: "Open settings",
    steps: jev ? undefined : settingsSteps(["Under Jev, pick the API key (a Paperclip secret) and keep it enabled."]),
    agentNext: jev ? null : "Inbox triage and feature tagging start on the next runs.",
  });

  const program = await attempt(ctx, "growth program", () => sqlGrowthStore(ctx).findProgram(companyId, GROWTH_CHANNEL, null));
  const hasProgram = program.ok && Boolean(program.value);
  items.push({
    key: "growth_program",
    title: "Set up the Growth Lab program",
    status: !program.ok ? "unknown" : hasProgram ? "done" : "optional",
    required: false,
    detail: hasProgram
      ? `Objective: ${program.ok && program.value ? program.value.objective || "not set" : ""}. Autopilot: ${program.ok && program.value ? program.value.autopilot : ""}.`
      : "Optional. The Growth Lab scores posts, runs experiments and keeps the playbook the agent plans from.",
    href: "/social?tab=growth",
    hrefLabel: "Open Growth Lab",
    steps: hasProgram ? undefined : ["Open Social → Growth.", "Set the objective, topics and autopilot mode."],
    action: hasProgram ? null : { plugin: PLUGIN_ID, key: "social.growth-load", params: {}, label: "Create the program" },
    agentNext: "The agent reads the playbook before planning and proposes experiments.",
  });

  items.push(...apps.slice(1));

  return {
    plugin: PLUGIN_ID,
    module: "social",
    title: "Social",
    version: manifest.version,
    items,
    checkedAt: now.toISOString(),
  };
}
