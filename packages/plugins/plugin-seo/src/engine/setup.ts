/**
 * Setup checklist: every one-time grant the SEO agent needs, with its status,
 * a deep link, and what the agent does once it is in place. Pure, so the SEO
 * page, the sprint's Integrations tab and the `setup-checklist` tool agree.
 */
import type { NeedsYouLink } from "./needs-you.js";

export const GCP_PROJECT = "partners-in-biz-85059";
export const SA_CONSOLE_URL = `https://console.cloud.google.com/iam-admin/serviceaccounts?project=${GCP_PROJECT}`;
export const SITE_VERIFICATION_API_URL = `https://console.cloud.google.com/apis/library/siteverification.googleapis.com?project=${GCP_PROJECT}`;
export const SEARCH_CONSOLE_API_URL = `https://console.cloud.google.com/apis/library/searchconsole.googleapis.com?project=${GCP_PROJECT}`;
export const GITHUB_PAT_URL = "https://github.com/settings/personal-access-tokens/new";
export const BING_WEBMASTER_URL = "https://www.bing.com/webmasters";
export const PAGESPEED_KEY_URL = `https://console.cloud.google.com/apis/credentials?project=${GCP_PROJECT}`;

export type SetupStatus = "done" | "todo" | "warn" | "unknown";

export interface SetupItem {
  key: string;
  label: string;
  status: SetupStatus;
  detail: string;
  steps: string[];
  links: NeedsYouLink[];
  /** What the agent does next once this is in place. */
  next: string;
}

export interface SetupFacts {
  /** Company issue prefix, for Paperclip links. */
  prefix: string | null;
  /** Plugin settings page (by installation id), when known. */
  settingsPath: string | null;
  settingsSaved: boolean;
  serviceAccount: { configured: boolean; email: string | null; error: string | null };
  agent: { id: string; status: string } | null;
  pagespeedKey: boolean;
  bingKey: boolean;
  sprint?: {
    siteName: string;
    siteUrl: string;
    isClient: boolean;
    siteAccess: string;
    siteProjectId: string | null;
    repoUrl: string | null;
    changePolicy: string;
    autopilotMode: string;
    property: string | null;
    gscVia: "service_account" | "oauth" | null;
    bingVerified: boolean;
  };
}

function p(prefix: string | null, path: string): string {
  return prefix ? `/${prefix}${path}` : path;
}

export const SERVICE_ACCOUNT_STEPS = [
  `Open Google Cloud → IAM → Service accounts (project ${GCP_PROJECT}) and click **Create service account**. Name it "paperclip-seo"; skip the optional role and user steps.`,
  "Open the new service account → **Keys** → **Add key** → **Create new key** → **JSON** → Create. A .json file downloads.",
  `Enable the **Site Verification API** and the **Google Search Console API** for the project (links below).`,
  "In Paperclip: Settings → Secrets → **New secret** named `SEO_GOOGLE_SERVICE_ACCOUNT`, paste the whole JSON file as the value.",
  "Settings → Plugins → SEO → **Google service account key** → pick that secret → **Save**.",
];

export function githubTokenSteps(prefix: string | null, repo: string | null): string[] {
  return [
    `Create a fine-grained personal access token at GitHub → Settings → Developer settings → Fine-grained tokens → Generate new token. Repository access: only ${repo ?? "the site repo"}. Permissions: Contents read and write, Pull requests read and write, Commit statuses read, Checks read, Metadata read.`,
    `In Paperclip open Settings → Secrets (${p(prefix, "/company/settings/secrets")}) and add it as a company secret named \`GITHUB_TOKEN\`. Paperclip uses it for project workspace git and gives it to the agent as $GITHUB_TOKEN.`,
  ];
}

export function siteProjectSteps(prefix: string | null, siteName: string, repoUrl: string | null): string[] {
  return [
    `Open Projects (${p(prefix, "/projects")}) → **New project**, name it after the site (e.g. "${siteName} website").`,
    `In the project add a **workspace** with the repo URL ${repoUrl ?? "(the site's GitHub repo, e.g. https://github.com/<org>/<repo>)"} and the default branch (usually main).`,
    "Back here: SEO → this sprint → Integrations → **Site repo** → pick the project → Save. The repo URL is read from the project's workspace.",
    "No repo (a CMS or a client-managed site)? Choose **No repo access** instead: the agent writes exact change sets and sends them through the Needs you digest.",
  ];
}

export function buildSetupChecklist(f: SetupFacts): SetupItem[] {
  const items: SetupItem[] = [];
  const settingsLink: NeedsYouLink = { label: "SEO settings", url: f.settingsPath ?? p(f.prefix, "/company/settings/instance/plugins") };

  items.push({
    key: "settings",
    label: "SEO settings saved",
    status: f.settingsSaved ? "done" : "todo",
    detail: f.settingsSaved ? "Saved: the hourly and weekly jobs run for this company." : "Not saved: the daily and weekly SEO jobs skip this company.",
    steps: f.settingsSaved ? [] : ["Open Settings → Plugins → SEO and click **Save** once (defaults are fine)."],
    links: [settingsLink],
    next: "Runs the daily SEO job for every sprint (tasks, Search Console pulls, checks) and the weekly review.",
  });

  const sa = f.serviceAccount;
  items.push({
    key: "service_account",
    label: "Google service account key",
    status: sa.configured && !sa.error ? "done" : sa.error ? "warn" : "todo",
    detail: sa.configured && !sa.error
      ? `Using ${sa.email}. Add this email as a user on client Search Console properties.`
      : sa.error ?? "Not set: Search Console only works through a person's OAuth connection (fallback).",
    steps: sa.configured && !sa.error ? [] : SERVICE_ACCOUNT_STEPS,
    links: [
      { label: "Service accounts", url: SA_CONSOLE_URL },
      { label: "Enable Site Verification API", url: SITE_VERIFICATION_API_URL },
      { label: "Enable Search Console API", url: SEARCH_CONSOLE_API_URL },
      settingsLink,
    ],
    next: "Verifies our own sites itself (meta tag through the repo), adds the Search Console property, submits sitemaps and pulls rankings daily — no OAuth clicks.",
  });

  items.push({
    key: "github_token",
    label: "GitHub access for the agent",
    status: "unknown",
    detail: "The plugin cannot read company secrets. The agent reports on its first push if `GITHUB_TOKEN` is missing or lacks access.",
    steps: githubTokenSteps(f.prefix, f.sprint?.repoUrl ?? null),
    links: [
      { label: "New GitHub token", url: GITHUB_PAT_URL },
      { label: "Paperclip secrets", url: p(f.prefix, "/company/settings/secrets") },
    ],
    next: "Pushes `seo/<task>` branches, opens PRs, reads CI and Vercel checks, and merges SEO-scope PRs itself.",
  });

  const agentDown = f.agent ? ["paused", "pending_approval", "terminated", "error"].includes(f.agent.status) : false;
  items.push({
    key: "agent",
    label: "SEO agent linked",
    status: !f.agent ? "todo" : agentDown ? "warn" : "done",
    detail: !f.agent ? "No SEO agent linked: agent tasks wait unassigned." : agentDown ? `Linked but ${f.agent.status.replace(/_/g, " ")}: it is not woken for tasks.` : `Linked (${f.agent.status}).`,
    steps: !f.agent
      ? ["SEO page → **Activate SEO agent** (opens a hire task), or **Link agent** to pick an existing one."]
      : agentDown
        ? ["Open the agent, check its adapter has a working model key, then **Resume**. Enable the \"Run today's SEO\" and \"Weekly SEO review\" routine triggers."]
        : [],
    links: f.agent ? [{ label: "Agent", url: p(f.prefix, `/agents/${f.agent.id}`) }, { label: "Routines", url: p(f.prefix, "/routines") }] : [{ label: "SEO page", url: p(f.prefix, "/seo") }],
    next: "Works every due task, closes each with evidence, and posts a digest per sprint.",
  });

  items.push({
    key: "pagespeed_key",
    label: "PageSpeed API key (optional)",
    status: f.pagespeedKey ? "done" : "warn",
    detail: f.pagespeedKey ? "Set." : "Not set: Google may rate-limit the daily PageSpeed checks.",
    steps: f.pagespeedKey ? [] : ["Google Cloud → APIs & Services → Credentials → **Create credentials → API key**, restrict it to PageSpeed Insights API.", "Add it as a secret and pick it in SEO settings → PageSpeed Insights API key."],
    links: [{ label: "Google Cloud credentials", url: PAGESPEED_KEY_URL }, settingsLink],
    next: "Checks Core Web Vitals on the home page and 3 rotating pages every day.",
  });

  items.push({
    key: "bing_key",
    label: "Bing Webmaster API key",
    status: f.bingKey ? "done" : "todo",
    detail: f.bingKey ? "Set." : "Not set: the agent cannot add or verify sites in Bing.",
    steps: f.bingKey ? [] : [`Sign in at ${BING_WEBMASTER_URL} (any Microsoft account; one account covers every site).`, "Settings (gear) → **API access** → **API key** → Generate → copy.", "Add it as a secret and pick it in SEO settings → Bing Webmaster API key → Save."],
    links: [{ label: "Bing Webmaster Tools", url: BING_WEBMASTER_URL }, settingsLink],
    next: "Adds each site to Bing, verifies it with BingSiteAuth.xml through the repo, submits the sitemap and core URLs.",
  });

  const s = f.sprint;
  if (s) {
    const linked = s.siteAccess === "repo" && s.siteProjectId;
    items.push({
      key: "site_project",
      label: "Site repo linked",
      status: linked ? (s.repoUrl ? "done" : "warn") : s.siteAccess === "none" ? "done" : "todo",
      detail: linked
        ? s.repoUrl
          ? `Repo ${s.repoUrl} · change policy ${s.changePolicy.replace(/_/g, " ")}.`
          : "Project linked, but its workspace has no repo URL."
        : s.siteAccess === "none"
          ? "No repo access (CMS or client-managed): the agent sends exact change sets through the Needs you digest."
          : "Not linked: code and content tasks wait until the site's repo project is linked.",
      steps: linked && s.repoUrl ? [] : s.siteAccess === "none" ? [] : siteProjectSteps(f.prefix, s.siteName, s.repoUrl),
      links: [{ label: "Projects", url: p(f.prefix, "/projects") }, ...(s.siteProjectId ? [{ label: "Site project", url: p(f.prefix, `/projects/${s.siteProjectId}`) }] : [])],
      next: "Opens every code and content task in the site project, works on `seo/<task>` branches, opens PRs and merges SEO-scope changes when checks pass.",
    });
    items.push({
      key: "gsc_property",
      label: "Search Console property",
      status: s.property ? "done" : "todo",
      detail: s.property
        ? `${s.property} via ${s.gscVia === "oauth" ? "an OAuth connection (fallback)" : "the service account"}.`
        : s.isClient
          ? "Not connected: the client adds the service account as a user (the agent drafts the email in Needs you)."
          : "Not verified yet: the agent verifies it with the service account through the repo.",
      steps: s.property ? [] : s.isClient ? ["Send the client the email from the Needs you digest (it has the service account email and the Search Console Users link)."] : ["Nothing for you once the service account key and the site repo are set: the agent runs gsc-verification-token → PR → gsc-verify-site."],
      links: [],
      next: "Submits the sitemap, pulls rankings every morning, and inspects core URLs.",
    });
    items.push({
      key: "bing_site",
      label: "Bing site verified",
      status: s.bingVerified ? "done" : "todo",
      detail: s.bingVerified ? "Verified." : f.bingKey ? "The agent adds and verifies it (bing-add-site → repo → bing-verify-site)." : "Needs the Bing API key first.",
      steps: [],
      links: [],
      next: "Submits the sitemap and URL batches to Bing; IndexNow pings cover Bing too.",
    });
    items.push({
      key: "autopilot",
      label: "Autopilot",
      status: s.autopilotMode === "safe" ? "done" : s.autopilotMode === "full" ? "warn" : "todo",
      detail:
        s.autopilotMode === "safe"
          ? "safe (recommended): the agent does everything, merges SEO-scope PRs, and asks sign-off only for publishing posts, sending pitches and public announcements."
          : s.autopilotMode === "full"
            ? "full: the agent also publishes, sends and announces without sign-off."
            : "off: every agent task goes to the sprint owner. Set it to safe so the agent works the sprint.",
      steps: s.autopilotMode === "off" ? ["Sprint header → Autopilot → **safe**."] : [],
      links: [],
      next: "Works tasks in the chosen mode.",
    });
  }
  return items;
}

export function checklistSummary(items: SetupItem[]): { done: number; total: number; open: string[] } {
  const required = items.filter((i) => i.status !== "unknown");
  return { done: required.filter((i) => i.status === "done").length, total: required.length, open: items.filter((i) => i.status === "todo").map((i) => i.label) };
}
