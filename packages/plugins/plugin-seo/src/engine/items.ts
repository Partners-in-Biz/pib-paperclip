/**
 * The Needs you items the plugin raises itself: exact steps, deep links and
 * what the agent does afterwards. Pure.
 */
import { gscInspectLink, gscUsersLink } from "../integrations/google-sa.js";
import type { NewNeedsYouItem } from "./needs-you.js";
import {
  BING_WEBMASTER_URL,
  GITHUB_PAT_URL,
  githubTokenSteps,
  SA_CONSOLE_URL,
  SEARCH_CONSOLE_API_URL,
  SERVICE_ACCOUNT_STEPS,
  SITE_VERIFICATION_API_URL,
  siteProjectSteps,
} from "./setup.js";

type SprintLike = { siteName: string; siteUrl: string; clientName: string | null; repoUrl?: string | null };

function p(prefix: string | null, path: string): string {
  return prefix ? `/${prefix}${path}` : path;
}

export function linkSiteItem(ctx: { prefix: string | null }, sprint: SprintLike, taskIds: string[] = []): NewNeedsYouItem {
  return {
    key: "site_project",
    kind: "grant",
    title: `Link the ${sprint.siteName} repo to the sprint`,
    why: "Meta tags, schema, sitemap, verification files and new pages are changes to the site's code. The agent makes them itself once it knows which Paperclip project holds the repo.",
    steps: siteProjectSteps(ctx.prefix, sprint.siteName, sprint.repoUrl ?? null),
    links: [{ label: "Projects", url: p(ctx.prefix, "/projects") }],
    after: "Opens the waiting code tasks in the site project and works them on seo/<task> branches: PR, checks, preview verification, merge of SEO-scope changes.",
    check: "site_project",
    taskIds,
  };
}

export function serviceAccountItem(ctx: { prefix: string | null; settingsPath: string | null }, taskIds: string[] = []): NewNeedsYouItem {
  return {
    key: "service_account",
    kind: "grant",
    title: "Add the Google service account key",
    why: "One service account lets the agent verify our sites, add Search Console properties, submit sitemaps and read rankings without anyone clicking Connect.",
    steps: SERVICE_ACCOUNT_STEPS,
    links: [
      { label: "Service accounts", url: SA_CONSOLE_URL },
      { label: "Enable Site Verification API", url: SITE_VERIFICATION_API_URL },
      { label: "Enable Search Console API", url: SEARCH_CONSOLE_API_URL },
      { label: "SEO settings", url: ctx.settingsPath ?? p(ctx.prefix, "/company/settings/instance/plugins") },
    ],
    after: "Verifies the site with the service account (meta tag through the repo), adds the Search Console property and submits the sitemap.",
    check: "service_account",
    taskIds,
  };
}

export function githubTokenItem(ctx: { prefix: string | null }, sprint: SprintLike, detail: string, taskIds: string[] = []): NewNeedsYouItem {
  return {
    key: "github_token",
    kind: "grant",
    title: "Give the agent GitHub access",
    why: `The agent could not push or open a PR for ${sprint.siteName}: ${detail}`,
    steps: githubTokenSteps(ctx.prefix, sprint.repoUrl ?? null),
    links: [
      { label: "New GitHub token", url: GITHUB_PAT_URL },
      { label: "Paperclip secrets", url: p(ctx.prefix, "/company/settings/secrets") },
    ],
    after: "Pushes the branch, opens the PR and continues the task.",
    check: "manual",
    taskIds,
  };
}

/** Email text for a client to add the service account to their Search Console property. */
export function clientAccessEmail(input: { clientName: string | null; siteUrl: string; serviceAccountEmail: string; property: string }): string {
  return [
    `Hi${input.clientName ? ` ${input.clientName}` : ""},`,
    "",
    `To run your SEO sprint we need read access to Google Search Console for ${input.siteUrl}. It takes a minute:`,
    "",
    `1. Open ${gscUsersLink(input.property)} (sign in with the Google account that owns the property).`,
    "2. Click ADD USER.",
    `3. Email: ${input.serviceAccountEmail}`,
    "4. Permission: Full (Restricted also works for reports only; Full lets us submit sitemaps).",
    "5. Click ADD.",
    "",
    "If you do not have Search Console set up for the site yet, reply and we will help you verify it.",
    "",
    "Thank you!",
  ].join("\n");
}

export function clientGscAccessItem(sprint: SprintLike, serviceAccountEmail: string, property: string, taskIds: string[] = []): NewNeedsYouItem {
  return {
    key: "gsc_access",
    kind: "message",
    title: `Ask ${sprint.clientName ?? "the client"} to add our service account in Search Console`,
    why: `The agent has no access to ${property}. The client adds ${serviceAccountEmail} as a user once; nothing else is needed from them.`,
    steps: ["Send the email below to the client (from your email).", "Nothing else: the agent checks access every morning (gsc-check-access)."],
    links: [{ label: "Search Console users", url: gscUsersLink(property) }],
    copy: clientAccessEmail({ clientName: sprint.clientName, siteUrl: sprint.siteUrl, serviceAccountEmail, property }),
    after: "Selects the property, submits the sitemap and starts the daily ranking pulls.",
    check: "gsc_access",
    taskIds,
  };
}

export function dnsTxtItem(sprint: SprintLike, value: string, taskIds: string[] = []): NewNeedsYouItem {
  return {
    key: "gsc_dns",
    kind: "grant",
    title: `Add a DNS TXT record for ${new URL(sprint.siteUrl).hostname.replace(/^www\./, "")}`,
    why: "A Domain property in Search Console can only be verified through DNS, and the agent has no DNS access.",
    steps: ["Open the domain's DNS settings (registrar or Cloudflare).", `Add a TXT record: host @ (the bare domain), value ${value}.`, "Save. DNS can take up to an hour."],
    links: [],
    after: "Runs gsc-verify-site, adds the Domain property and submits the sitemap.",
    check: "gsc_access",
    taskIds,
  };
}

export function bingKeyItem(ctx: { prefix: string | null; settingsPath: string | null }, taskIds: string[] = []): NewNeedsYouItem {
  return {
    key: "bing_key",
    kind: "grant",
    title: "Add the Bing Webmaster API key",
    why: "With one API key the agent adds, verifies and submits every site to Bing itself.",
    steps: [
      `Sign in at ${BING_WEBMASTER_URL} with any Microsoft account (one account covers every site).`,
      "Settings (gear, top right) → **API access** → **API key** → Generate, then copy it.",
      "Paperclip Settings → Secrets → new secret `SEO_BING_API_KEY` with the key; then Settings → Plugins → SEO → Bing Webmaster API key → pick it → Save.",
    ],
    links: [{ label: "Bing Webmaster Tools", url: BING_WEBMASTER_URL }, { label: "SEO settings", url: ctx.settingsPath ?? p(ctx.prefix, "/company/settings/instance/plugins") }],
    after: "Adds the site to Bing, verifies it with BingSiteAuth.xml through the repo, submits the sitemap and core URLs.",
    check: "bing_key",
    taskIds,
  };
}

export function prMergeItem(input: { url: string; title: string; reasons: string[]; taskIds: string[] }): NewNeedsYouItem {
  return {
    key: `pr:${input.url}`,
    kind: "pr",
    title: `Review and merge: ${input.title}`,
    why: input.reasons.length > 0 ? input.reasons.join(" ") : "The change is outside the SEO scope the agent may merge alone.",
    steps: ["Open the PR, check the preview, and merge it (or comment what to change)."],
    links: [{ label: "Pull request", url: input.url }],
    after: "Re-checks production after the deploy and closes the task with the evidence.",
    check: input.taskIds.length > 0 ? "task_done" : "manual",
    taskIds: input.taskIds,
  };
}

export function indexingFollowUpItem(property: string, urls: string[]): NewNeedsYouItem {
  return {
    key: "indexing_followup",
    kind: "indexing",
    title: `Request indexing for ${urls.length} page(s) still not indexed after 14 days`,
    why: "Google offers no public API to request indexing for normal pages. The sitemap and IndexNow are already submitted; a manual request can speed up the last few.",
    steps: ["Open each link, wait for the inspection, click **Request indexing**."],
    links: urls.slice(0, 10).map((url) => ({ label: url.replace(/^https?:\/\//, ""), url: gscInspectLink(property, url) })),
    after: "Re-inspects the pages next week and records the result.",
    check: "manual",
    optional: true,
  };
}

export function gscReconnectItem(cockpitPath: string | null, error: string): NewNeedsYouItem {
  return {
    key: "gsc_reconnect",
    kind: "grant",
    title: "Reconnect Google Search Console (OAuth fallback)",
    why: `Google rejected the stored OAuth access (${error}). Adding the service account key removes this step for good.`,
    steps: ["Open the sprint's Integrations tab and click **Connect Google Search Console**, or add the service account key instead (see the setup checklist)."],
    links: cockpitPath ? [{ label: "Integrations", url: `${cockpitPath}&tab=integrations` }] : [],
    after: "Pulls rankings again every morning.",
    check: "gsc_access",
  };
}
