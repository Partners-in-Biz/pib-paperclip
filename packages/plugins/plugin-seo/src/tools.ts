/**
 * Agent tool declarations (exposed as `partnersinbiz.seo:<name>`). The plugin
 * never writes content: tools are deterministic, except keyword intent, which
 * Jev classifies when a TypeSafe key is set (word rules otherwise).
 *
 * Every parameter has a one-line description and fixed values are enums
 * (tests/tool-params.spec.ts checks both).
 */
import type { JsonSchema, PluginToolDeclaration } from "@paperclipai/plugin-sdk";
import { PLAYBOOK_SECTIONS } from "./engine/playbook.js";
import { CHANGE_POLICIES, HOSTINGS, SEO_SCOPE_CATEGORIES } from "./engine/site-change.js";
import { AUTOPILOT_MODES, SPRINT_STATUSES, TASK_STATUSES } from "./engine/sprint.js";
import { BUSINESS_TYPES } from "./templates/plans.js";

const text = (description: string): JsonSchema => ({ type: "string", description });
const int = (description: string): JsonSchema => ({ type: "integer", description });
const number = (description: string): JsonSchema => ({ type: "number", description });
const flag = (description: string): JsonSchema => ({ type: "boolean", description });
const list = (description: string): JsonSchema => ({ type: "array", items: { type: "string" }, description });
const choice = (values: readonly string[], description: string): JsonSchema => ({ type: "string", enum: [...values], description });
/** A list whose items are fixed values. */
const choices = (values: readonly string[], description: string): JsonSchema => ({ type: "array", items: { type: "string", enum: [...values] }, description });

function schema(required: string[], properties: Record<string, JsonSchema>): JsonSchema {
  return { type: "object", required, properties, additionalProperties: false };
}

// Values service/data.ts accepts. That module is node-only, so the manifest
// does not import it; tests/tool-params.spec.ts keeps these equal to its constants.
const INTENTS = ["problem", "solution", "brand"] as const;
const BACKLINK_TYPES = ["directory", "community", "guest_post", "link_trade", "organic", "citation", "other"] as const;
const BACKLINK_STATUSES = ["not_started", "in_progress", "submitted", "live", "rejected", "lost"] as const;
const CONTENT_TYPES = ["post", "page", "comparison", "alternative", "use-case", "pillar", "cluster", "how-to", "feature"] as const;
const CONTENT_STATUSES = ["idea", "drafting", "review", "scheduled", "live", "archived"] as const;
const FINDING_SEVERITIES = ["critical", "high", "medium", "low", "info"] as const;
/** The Social plugin's platforms (its ALL_PLATFORMS). */
const SOCIAL_PLATFORMS = ["facebook", "instagram", "threads", "linkedin", "x", "tiktok", "youtube", "pinterest", "reddit", "bluesky", "mastodon", "dribbble"] as const;

const sprintId = text("Sprint id (from list-sprints or today)");
const taskId = text("Task id (from today or list-tasks; also in the issue description)");
const urlOrSprint = {
  sprintId: text("Sprint id: records findings on the sprint and defaults the URL to the sprint site"),
  url: text("Absolute URL, or a path like /pricing when sprintId is given"),
};
const keywordId = text("Keyword id (from list-keywords)");
const INTENT = "problem (researching the pain), solution (comparing providers) or brand (this site's own name)";
const keywordTargetUrl = text("Page meant to rank: absolute URL or a path like /pricing");
const keywordVolume = int("Only from a real source");
const keywordDr = int("Your DR estimate of the top results (0–100)");
const backlinkDr = int("Domain rating of the linking site (0–100), only from a real source");
const submitUrl = text("Submission page URL (where the listing is submitted)");
const contentId = text("Content row id (from list-content)");
const contentUrl = text("Its URL: absolute, or a path like /blog/post");
const contentKeywordId = text("Keyword it targets (id from list-keywords, same sprint)");
const publishOn = text("Planned publish date, YYYY-MM-DD");
const optimizationId = text("Optimization id (from list-optimizations)");
const bingTaskId = text("The task this is for (resumed when the missing Bing key is added)");
const FOUND_SITEMAP = "default: the first Sitemap in robots.txt, else /sitemap.xml";

/**
 * Who a sprint is for. `client` is the preferred form; the flat
 * `clientKind` + `clientRef` pair is accepted too.
 */
function clientProps(clientDescription: string): Record<string, JsonSchema> {
  return {
    client: text(clientDescription),
    clientKind: choice(["company", "contact"], "With clientRef: the kind of CRM record (default company). Prefer client."),
    clientRef: text("CRM company or contact id (with clientKind). Prefer client."),
  };
}

const CLIENT_FILTER = 'Filter by who the sprint is for: "own" for Partners in Biz\'s own sites, "company:<CRM company id>" or "contact:<CRM contact id>" for one client. Omit for every sprint.';

/** The 90-day plan by business type (templates/plans.ts; the skill explains each). */
const BUSINESS_TYPE_TEXT = "Plan for the business: local (local service), professional (firms), ecommerce (online shop) or saas (software). Pick it from the CRM client profile";

export interface SeoToolDeclaration extends PluginToolDeclaration {
  /** Group used to render references/tools.md. */
  group: string;
}

export const SEO_TOOL_DECLARATIONS: SeoToolDeclaration[] = [
  // Sprints
  { group: "Sprints", name: "list-sprints", displayName: "List SEO sprints", description: "List sprints with client, plan (businessType), day/week/phase, status, autopilot, task counts (due, overdue, stuck, waiting on a person; see the skill's Words) and the next thing due. Each sprint's `client` (null = Partners in Biz's own site) is what other tools take as `client`.", parametersSchema: schema([], { status: choice(SPRINT_STATUSES, "Only sprints with this status"), ...clientProps(CLIENT_FILTER) }) },
  {
    group: "Sprints",
    name: "create-sprint",
    displayName: "Create SEO sprint",
    description: "Start a 90-day sprint for one site: seeds the plan for its business type (42–46 tasks and 13–15 directories or citations), creates the sprint root issue in the SEO project, and opens the tasks that are already due. Omit client for Partners in Biz's own sites; for client work pass the CRM client (the name comes from the CRM) and the businessType that fits it.",
    parametersSchema: schema(["siteUrl"], {
      siteUrl: text("The site, e.g. https://example.co.za"),
      ...clientProps('Who the sprint is for: "company:<CRM company id>" or "contact:<CRM contact id>" (a sole trader). Omit for Partners in Biz\'s own sites.'),
      siteName: text("Display name for the site (default: the client name, or the domain for own sites)"),
      businessType: choice(BUSINESS_TYPES, `${BUSINESS_TYPE_TEXT}; default local for a client, saas for own sites`),
      startDate: text("Day 0 (launch day), YYYY-MM-DD; default today"),
      ownerUserId: text("User who owns the sprint and receives human tasks; default: the person responsible for this run. 'none' for no owner"),
      autopilotMode: choice(["off", "safe"], "Agents may create sprints in off or safe mode only"),
      notes: text("Site access and constraints for the agent (repo, CMS, who deploys)"),
    }),
  },
  { group: "Sprints", name: "get-sprint", displayName: "Get SEO sprint", description: "One sprint with integrations, keyword counts, page health, snapshots and scoreboard.", parametersSchema: schema(["sprintId"], { sprintId }) },
  { group: "Sprints", name: "today", displayName: "Today's SEO plan", description: "What to do now: due, in-progress and blocked tasks (with issue ids), proposals, integration status and next steps, per sprint with its client. Omit sprintId for every active sprint (narrow with client).", parametersSchema: schema([], { sprintId, ...clientProps(CLIENT_FILTER) }) },
  { group: "Sprints", name: "set-autopilot", displayName: "Set sprint autopilot", description: "off: tasks go to the owner. safe: agent works its tasks; publish/send/deploy tasks need sign-off. full: no sign-off. Agents may only lower it.", parametersSchema: schema(["sprintId", "mode"], { sprintId, mode: choice(AUTOPILOT_MODES, "New autopilot mode; agents may only lower it") }) },
  {
    group: "Sprints",
    name: "update-sprint",
    displayName: "Update SEO sprint",
    description: "Change the site name or the notes the agent reads (site access, constraints). People only: move the sprint to another client or back to Partners in Biz's own sites.",
    parametersSchema: schema(["sprintId"], {
      sprintId,
      siteName: text("New display name for the site (max 200 chars)"),
      notes: text("Site access and constraints the agent reads (max 4000 chars; an empty string clears them)"),
      ...clientProps('People only: "company:<CRM company id>", "contact:<CRM contact id>", or "own" for Partners in Biz\'s own sites.'),
    }),
  },
  {
    group: "Sprints",
    name: "change-plan",
    displayName: "Change a sprint's plan",
    description: "Move a sprint to the 90-day plan that fits its business (local: Google Business Profile, SA directories, reviews, service and area pages; professional: expertise pages, case studies, professional bodies; ecommerce: category and product pages, Merchant Center; saas: comparison pages, G2, Product Hunt). Adds the new plan's missing tasks and directories (the due ones open now), rewords shared tasks nobody started, marks the old plan's unstarted tasks not needed (their issues are cancelled) and its unstarted directories not relevant. Started tasks stay open: finish or skip them.",
    parametersSchema: schema(["sprintId", "businessType"], {
      sprintId,
      businessType: choice(BUSINESS_TYPES, BUSINESS_TYPE_TEXT),
      reason: text("Why the plan changes, posted on the sprint root issue (max 1000 chars)"),
    }),
  },
  { group: "Sprints", name: "pause-sprint", displayName: "Pause SEO sprint", description: "Stop the daily run and new task issues for a sprint.", parametersSchema: schema(["sprintId"], { sprintId, reason: text("Why it is paused, posted on the sprint root issue (max 1000 chars)") }) },
  { group: "Sprints", name: "resume-sprint", displayName: "Resume SEO sprint", description: "Resume a paused or archived sprint; its status follows the calendar again.", parametersSchema: schema(["sprintId"], { sprintId }) },
  { group: "Sprints", name: "archive-sprint", displayName: "Archive SEO sprint", description: "End a sprint. Nothing runs for it afterwards.", parametersSchema: schema(["sprintId"], { sprintId, reason: text("Why it ends, posted on the sprint root issue (max 1000 chars)") }) },
  { group: "Sprints", name: "post-digest", displayName: "Post SEO digest", description: "Post a digest comment on the sprint root issue: your summary plus today's completed and waiting tasks.", parametersSchema: schema(["sprintId", "summary"], { sprintId, summary: text("What you did, what moved, what is next — real numbers only") }) },

  // Tasks
  {
    group: "Tasks",
    name: "list-tasks",
    displayName: "List sprint tasks",
    description: "Tasks of a sprint with status and issue ids.",
    parametersSchema: schema(["sprintId"], {
      sprintId,
      status: choices(TASK_STATUSES, `Only tasks with these statuses: ${TASK_STATUSES.join(", ")} (default: all)`),
      week: int("Only tasks of this sprint week (0 = pre-launch)"),
      owner: choice(["agent", "human"], "Only the agent's or a person's tasks"),
      source: choice(["template", "manual", "optimization"], "template = the sprint's 90-day plan, manual = add-task, optimization = approved optimizations"),
      dueOnly: flag("Only tasks due by today"),
    }),
  },
  { group: "Tasks", name: "start-task", displayName: "Start sprint task", description: "Mark a task in progress.", parametersSchema: schema(["taskId"], { taskId, note: text("Comment posted on the task's issue (max 2000 chars)") }) },
  {
    group: "Tasks",
    name: "complete-task",
    displayName: "Complete sprint task",
    description: "Record evidence and close the task and its issue. Some task types check the sprint data first (keywords tracked, directories handled, day-90 snapshot). In safe mode, tasks that need sign-off are refused: use block-task with review: true.",
    parametersSchema: schema(["taskId", "summary"], {
      taskId,
      summary: text("What was done and the result"),
      links: list("PRs, commits, live URLs, drafts"),
      artifacts: {
        type: "array",
        items: {
          type: "object",
          properties: {
            label: text("Name of the output, e.g. new title (cut at 200 chars)"),
            url: text("Where the output lives (cut at 1000 chars)"),
            value: text("The output itself, e.g. the new title text (cut at 4000 chars)"),
          },
          required: ["label"],
        },
        description: "Named outputs (e.g. 'new title', 'schema JSON-LD')",
      },
    }),
  },
  {
    group: "Tasks",
    name: "block-task",
    displayName: "Hand a task to a person",
    description: "Only for a true one-time grant or judgement. Blocked (review false): the ask goes on the sprint's weekly Needs you issue and the task comes back to you when it is done. Ready for sign-off (review true): the issue goes to the sprint owner's review and is listed on Needs you.",
    parametersSchema: schema(["taskId", "reason", "humanAsk"], {
      taskId,
      reason: text("What happened / what you prepared"),
      humanAsk: text("Exactly what the person must do, with links"),
      review: flag("true = the work is ready and needs sign-off"),
      links: list("URLs the person needs (PR, draft, preview), max 20; a GitHub PR on a sign-off becomes your merge task once approved"),
    }),
  },
  { group: "Tasks", name: "skip-task", displayName: "Skip sprint task", description: "Mark a task skipped (not relevant for this site) with the reason; cancels its issue.", parametersSchema: schema(["taskId", "reason"], { taskId, reason: text("Why the task does not apply to this site (max 2000 chars)") }) },
  {
    group: "Tasks",
    name: "add-task",
    displayName: "Add sprint task",
    description: "Add a manual task (default: this week, agent-owned) and open its issue if it is due.",
    parametersSchema: schema(["sprintId", "title"], {
      sprintId,
      title: text("Task title (max 240 chars)"),
      description: text("Details for its issue, or the why on Needs you for a person's task (max 8000 chars)"),
      taskType: text("Free-form type, default custom"),
      owner: choice(["agent", "human"], "Who does it (default agent); human = on Needs you unless autopilot is off. Site code changes stay agent work"),
      week: int("Sprint week; default the current week"),
      autopilotEligible: flag("false = needs sign-off in safe mode"),
      createIssue: flag("Open its issue now when it is due (default true; else the daily run opens it)"),
    }),
  },

  // Keywords
  { group: "Keywords", name: "list-keywords", displayName: "List keywords", description: "Tracked keywords with current position, impressions, clicks, CTR, intent and target URL.", parametersSchema: schema(["sprintId"], { sprintId, includeRetired: flag("Include retired keywords (default false)") }) },
  {
    group: "Keywords",
    name: "add-keywords",
    displayName: "Add keywords",
    description: "Track keywords in bulk (duplicates are skipped). Never invent volume. A keyword without an intent gets one from Jev (when it is sure) or the word rules.",
    parametersSchema: schema(["sprintId", "keywords"], {
      sprintId,
      keywords: {
        type: "array",
        items: {
          type: "object",
          required: ["phrase"],
          properties: {
            phrase: text("The search phrase (max 200 chars)"),
            intent: choice(INTENTS, `${INTENT}; omitted: Jev or the word rules set it`),
            targetUrl: keywordTargetUrl,
            volume: keywordVolume,
            difficultyDr: keywordDr,
            priority: flag("Priority keyword: its target URL is among request-indexing's default pages (default false)"),
            notes: text("Notes (max 2000 chars)"),
          },
        },
        description: "Keywords to track, 1–200 per call",
      },
    }),
  },
  {
    group: "Keywords",
    name: "update-keyword",
    displayName: "Update keyword",
    description: "Change intent, target URL, priority, DR estimate, volume or notes.",
    parametersSchema: schema(["keywordId"], {
      keywordId,
      phrase: text("New phrase (max 200 chars); refused if the sprint already tracks it"),
      intent: choice(INTENTS, INTENT),
      targetUrl: text("Page meant to rank: absolute URL or a path like /pricing; an empty string clears it"),
      priority: flag("Priority keyword: its target URL is among request-indexing's default pages"),
      difficultyDr: keywordDr,
      volume: keywordVolume,
      notes: text("Notes (max 2000 chars); an empty string clears them"),
    }),
  },
  { group: "Keywords", name: "retire-keyword", displayName: "Retire keyword", description: "Stop tracking a keyword (history is kept).", parametersSchema: schema(["keywordId"], { keywordId, reason: text("Why it is no longer tracked (max 500 chars)") }) },
  {
    group: "Keywords",
    name: "record-position",
    displayName: "Record keyword position",
    description: "Record a position you observed yourself (source manual). GSC positions arrive automatically each day.",
    parametersSchema: schema(["position"], {
      keywordId: text("Keyword id (from list-keywords); or pass sprintId and phrase"),
      sprintId: text("With phrase, when you have no keywordId"),
      phrase: text("With sprintId: the keyword phrase; a phrase not tracked yet is added (max 200 chars)"),
      position: number("Position you observed, 0.5–500 (e.g. 12)"),
      impressions: int("Impressions you observed (optional)"),
      clicks: int("Clicks you observed (optional)"),
      recordedOn: text("Day observed, YYYY-MM-DD (default today)"),
    }),
  },
  { group: "Keywords", name: "keyword-history", displayName: "Keyword position history", description: "Daily positions (GSC and manual) for one keyword, oldest first.", parametersSchema: schema(["keywordId"], { keywordId, limit: int("Latest positions to return, 1–365 (default 90)") }) },
  {
    group: "Keywords",
    name: "discover-keywords",
    displayName: "Discover keywords",
    description: "Google Autocomplete suggestions plus seed variants (alternative, vs, best, how to, for small business, pricing) with an intent (Jev when sure, else word rules; see intentSource). Suggestions only — nothing is saved.",
    parametersSchema: schema(["seeds"], {
      seeds: list("1–8 seed terms"),
      sprintId,
      limit: int("Max suggestions, 1–200 (default 60)"),
      country: text("Two-letter country for autocomplete, default za"),
      language: text("Autocomplete language code (default en)"),
    }),
  },

  // Backlinks
  { group: "Backlinks", name: "list-backlinks", displayName: "List backlinks", description: "Backlinks and directory submissions with status.", parametersSchema: schema(["sprintId"], { sprintId, status: choice(BACKLINK_STATUSES, "Only backlinks with this status"), type: choice(BACKLINK_TYPES, "Only backlinks of this type") }) },
  {
    group: "Backlinks",
    name: "add-backlink",
    displayName: "Add backlink",
    description: "Track a link target or an earned link.",
    parametersSchema: schema(["sprintId", "domain"], {
      sprintId,
      domain: text("Linking site's domain, e.g. g2.com (a URL is reduced to its domain)"),
      source: text("Display name (default the domain)"),
      url: text("The linking or listing URL"),
      submitUrl,
      type: choice(BACKLINK_TYPES, "Kind of link (default other)"),
      dr: backlinkDr,
      status: choice(BACKLINK_STATUSES, "Where it stands (default not_started)"),
      notes: text("Notes, e.g. contact or submission details (max 4000 chars)"),
    }),
  },
  {
    group: "Backlinks",
    name: "update-backlink",
    displayName: "Update backlink",
    description: "Move a backlink through submitted → live (or rejected/lost). Submitted/rejected/lost need notes; live needs the listing url.",
    parametersSchema: schema(["backlinkId"], {
      backlinkId: text("Backlink id (from list-backlinks)"),
      status: choice(BACKLINK_STATUSES, "New status; submitted, rejected and lost need notes, live needs the url (unless already set)"),
      url: text("The linking or listing URL (needed to mark it live)"),
      submitUrl,
      dr: backlinkDr,
      type: choice(BACKLINK_TYPES, "Kind of link"),
      notes: text("Added to the existing notes on a new line (max 4000 chars)"),
    }),
  },

  // Content
  { group: "Content", name: "list-content", displayName: "List content", description: "Content pipeline with status, URLs, GSC impressions and pillar links.", parametersSchema: schema(["sprintId"], { sprintId, status: choice(CONTENT_STATUSES, "Only content at this stage"), type: choice(CONTENT_TYPES, "Only content of this type") }) },
  {
    group: "Content",
    name: "add-content",
    displayName: "Add content",
    description: "Add a page or post to the pipeline.",
    parametersSchema: schema(["sprintId", "title"], {
      sprintId,
      title: text("Title (max 300 chars)"),
      type: choice(CONTENT_TYPES, "Kind of page or post (default post)"),
      status: choice(CONTENT_STATUSES, "Stage (default idea); live = published today, and with targetUrl Social repurposes it"),
      targetKeywordId: contentKeywordId,
      targetUrl: contentUrl,
      publishOn,
      taskId: text("Publish task for this row (task id); completing it hands this row to Social"),
      notes: text("Notes (max 4000 chars)"),
    }),
  },
  {
    group: "Content",
    name: "update-content",
    displayName: "Update content",
    description: "Change status (live needs targetUrl), URL, keyword, internal links, or linksToPillarIds (ids of pillar content this item links to).",
    parametersSchema: schema(["contentId"], {
      contentId,
      title: text("New title (max 300 chars)"),
      type: choice(CONTENT_TYPES, "Kind of page or post"),
      status: choice(CONTENT_STATUSES, "New stage; live needs targetUrl (here or already set) and hands the row to Social"),
      targetUrl: contentUrl,
      targetKeywordId: contentKeywordId,
      publishOn,
      publishedOn: text("With status live: the date it went live, YYYY-MM-DD (default: kept, else today)"),
      internalLinksAdded: flag("Internal links for this item are added (a non-empty linksToPillarIds sets it too)"),
      linksToPillarIds: list("Ids of the pillar content rows this item links to (same sprint, max 20); replaces the list"),
      notes: text("Notes (max 4000 chars); an empty string clears them"),
    }),
  },
  {
    group: "Content",
    name: "link-social-post",
    displayName: "Link social post",
    description: "Record a Social plugin post that repurposes this content row (from the Social repurpose issue or partnersinbiz.social:list-posts). Idempotent per socialPostId.",
    parametersSchema: schema(["contentId", "socialPostId"], {
      contentId,
      socialPostId: text("Social post id (partnersinbiz.social post id)"),
      platform: choice(SOCIAL_PLATFORMS, "Platform of the post, shown next to the link"),
      url: text("Public post URL once published (optional)"),
    }),
  },

  // Site checks
  { group: "Site checks", name: "check-robots", displayName: "Check robots.txt", description: "Fetch and parse robots.txt: blocking rules for Googlebot/*, sitemaps.", parametersSchema: schema([], { ...urlOrSprint }) },
  { group: "Site checks", name: "check-sitemap", displayName: "Check sitemap", description: "Find (robots.txt or /sitemap.xml) and parse the sitemap or index, count URLs, spot-check a sample.", parametersSchema: schema([], { ...urlOrSprint, sitemapUrl: text(`Sitemap or index to check, URL or path (${FOUND_SITEMAP})`), sample: int("0–10 URLs to spot-check, default 5") }) },
  { group: "Site checks", name: "check-meta", displayName: "Check meta tags", description: "Title, description, h1, canonical, robots, Open Graph with length rules.", parametersSchema: schema([], { ...urlOrSprint }) },
  { group: "Site checks", name: "check-canonical", displayName: "Check canonical", description: "Canonical link/header vs the served URL.", parametersSchema: schema([], { ...urlOrSprint }) },
  { group: "Site checks", name: "validate-schema", displayName: "Validate structured data", description: "Extract and parse JSON-LD; report types, missing required properties and FAQ problems.", parametersSchema: schema([], { ...urlOrSprint }) },
  { group: "Site checks", name: "internal-link-audit", displayName: "Internal link audit", description: "Crawl up to 40 sitemap pages (20 s limit): inbound internal links per page, orphans, linked pages missing from the sitemap.", parametersSchema: schema([], { ...urlOrSprint, sitemapUrl: text(`Sitemap to crawl, URL or path (${FOUND_SITEMAP})`), maxPages: int("Pages to crawl, 1–40 (default 25)") }) },
  { group: "Site checks", name: "crawler-sim", displayName: "Crawler view", description: "Fetch as Googlebot: status, redirects, robots.txt block, noindex (meta and X-Robots-Tag), canonical, h1, text size, images without alt, indexable yes/no.", parametersSchema: schema([], { ...urlOrSprint }) },
  { group: "Site checks", name: "run-pagespeed", displayName: "Run PageSpeed Insights", description: "PageSpeed Insights for one URL (up to ~25 s): scores, LCP/CLS/INP (field data when Google has it), top opportunities. Saved to page health with sprintId.", parametersSchema: schema([], { ...urlOrSprint, strategy: choice(["mobile", "desktop"], "Device profile (default mobile; only mobile runs record CWV findings)") }) },

  // GSC
  { group: "Google Search Console", name: "gsc-connect-url", displayName: "GSC access status", description: "How this sprint reaches Search Console: the service account (preferred; its email and next step) or the OAuth fallback page.", parametersSchema: schema(["sprintId"], { sprintId }) },
  {
    group: "Google Search Console",
    name: "gsc-verification-token",
    displayName: "GSC verification token",
    description: "Site Verification API: the exact meta tag (META) or file (FILE) for a URL-prefix site, or the DNS TXT record for a domain property, for the service account to become a verified owner. Add it through the site repo, then gsc-verify-site.",
    parametersSchema: schema(["sprintId"], {
      sprintId,
      method: choice(["META", "FILE", "DNS_TXT"], "Default META (URL-prefix); DNS_TXT for a domain property"),
      property: choice(["url", "domain"], "url = URL-prefix property, domain = domain property (DNS TXT); default url"),
      taskId: text("The task this is for (resumed when a missing grant is added)"),
    }),
  },
  {
    group: "Google Search Console",
    name: "gsc-verify-site",
    displayName: "Verify site with the service account",
    description: "Verify the token that is live on the site (the service account becomes a verified owner), add the Search Console property, store it on the sprint and submit <site>/sitemap.xml.",
    parametersSchema: schema(["sprintId"], {
      sprintId,
      method: choice(["META", "FILE", "DNS_TXT"], "Default: the method from gsc-verification-token, else META"),
      submitSitemap: flag("Also submit <site origin>/sitemap.xml (default true)"),
    }),
  },
  {
    group: "Google Search Console",
    name: "gsc-check-access",
    displayName: "Check service account access",
    description: "Can the service account read this sprint's property? Selects it when yes. For client sites without access it puts the email (service account + Search Console Users link) on the Needs you issue.",
    parametersSchema: schema(["sprintId"], {
      sprintId,
      property: text("Property to check, e.g. sc-domain:example.com; default: detected from the site"),
      askClient: flag("Queue the client email even for own sites"),
      taskId: text("The task this is for (resumed when a missing grant is added)"),
    }),
  },
  { group: "Google Search Console", name: "gsc-properties", displayName: "GSC properties", description: "Properties the connected Google account can see, the selected one and a suggestion.", parametersSchema: schema(["sprintId"], { sprintId }) },
  { group: "Google Search Console", name: "gsc-set-property", displayName: "Select GSC property", description: "Choose the property (e.g. sc-domain:example.com) used for this sprint.", parametersSchema: schema(["sprintId", "propertyUrl"], { sprintId, propertyUrl: text("Property exactly as gsc-properties lists it, e.g. sc-domain:example.com") }) },
  { group: "Google Search Console", name: "gsc-pull", displayName: "Pull GSC data", description: "Pull the last 8 days (to yesterday) now: tracked keyword positions (impression-weighted), clicks, CTR, content impressions and site totals. The daily run does this automatically.", parametersSchema: schema(["sprintId"], { sprintId }) },
  {
    group: "Google Search Console",
    name: "gsc-query",
    displayName: "Query GSC",
    description: "Page+query rows for the last N days, optionally filtered by position band, page or query text (e.g. positionMin 8, positionMax 20 for stuck pages).",
    parametersSchema: schema(["sprintId"], {
      sprintId,
      days: int("Days back, ending yesterday, 1–90 (default 28)"),
      positionMin: number("Only rows at this position or worse (0–200), e.g. 8"),
      positionMax: number("Only rows at this position or better (0–200), e.g. 20"),
      page: text("Only this page: URL or a path like /pricing"),
      query: text("Only queries containing this text"),
      limit: int("Max rows, most impressions first, 1–500 (default 100)"),
    }),
  },
  { group: "Google Search Console", name: "gsc-submit-sitemap", displayName: "Submit sitemap to GSC", description: "Submit a sitemap to the selected property (default <site>/sitemap.xml).", parametersSchema: schema(["sprintId"], { sprintId, sitemapUrl: text("Sitemap URL or path (default <site origin>/sitemap.xml)") }) },
  { group: "Google Search Console", name: "gsc-inspect-url", displayName: "Inspect URL in GSC", description: "URL Inspection: verdict, coverage, robots state, last crawl, Google vs declared canonical. (Google has no public request-indexing API; use request-indexing.)", parametersSchema: schema(["sprintId", "url"], { sprintId, url: text("Page to inspect: absolute URL or a path like /pricing") }) },

  // Indexing and Bing
  { group: "Indexing and Bing", name: "indexnow-key", displayName: "IndexNow key", description: "The sprint's IndexNow key, the key file to add through the repo (public/<key>.txt), and whether it is live.", parametersSchema: schema(["sprintId"], { sprintId }) },
  {
    group: "Indexing and Bing",
    name: "request-indexing",
    displayName: "Get pages crawled",
    description: "Sitemap to Search Console, IndexNow ping (Bing and others; needs the live key file) and URL Inspection for up to 5 URLs (default: home + priority/live pages). The daily run re-inspects after 14 days and adds optional Search Console links to Needs you only for pages still not indexed.",
    parametersSchema: schema(["sprintId"], { sprintId, urls: list("Absolute URLs or paths; default the core pages"), sitemapUrl: text("Sitemap URL or path to submit (default <site origin>/sitemap.xml)") }),
  },
  { group: "Indexing and Bing", name: "bing-add-site", displayName: "Add site to Bing", description: "Bing Webmaster API AddSite; returns BingSiteAuth.xml and the msvalidate.01 meta tag to add through the repo. Without an API key it puts the key on Needs you.", parametersSchema: schema(["sprintId"], { sprintId, siteUrl: text("Site URL to add in Bing (default <site origin>/)"), taskId: bingTaskId }) },
  { group: "Indexing and Bing", name: "bing-verify-site", displayName: "Verify site in Bing", description: "Bing VerifySite once BingSiteAuth.xml is live; enables Bing on the sprint and submits the sitemap.", parametersSchema: schema(["sprintId"], { sprintId, submitSitemap: flag("Also submit <site origin>/sitemap.xml to Bing (default true)"), taskId: bingTaskId }) },
  { group: "Indexing and Bing", name: "bing-submit", displayName: "Submit to Bing", description: "SubmitSitemap and/or SubmitUrlBatch (up to 500 URLs).", parametersSchema: schema(["sprintId"], { sprintId, urls: list("URLs or paths to submit (max 500)"), sitemapUrl: text("Sitemap URL or path to submit; without urls, default <site origin>/sitemap.xml"), taskId: bingTaskId }) },

  // Site repo
  { group: "Site repo", name: "list-site-projects", displayName: "List site projects", description: "Paperclip projects that could hold the site repo (repo URL from their workspace), best match first, plus how to create one.", parametersSchema: schema([], { sprintId }) },
  {
    group: "Site repo",
    name: "link-site",
    displayName: "Link site repo",
    description: "Link the Paperclip project whose workspace holds the site repo (code and content tasks open there), or noRepo: true for a CMS / client-managed site. Also sets branch, framework, hosting and the change policy (agents may only lower it).",
    parametersSchema: schema(["sprintId"], {
      sprintId,
      projectId: text("Paperclip project whose workspace holds the site repo (from list-site-projects)"),
      noRepo: flag("No repo access: change sets go through Needs you"),
      unlink: flag("Remove the site link, back to unlinked (people only)"),
      defaultBranch: text("The repo's default branch (default: from the workspace, else main)"),
      framework: text("Site framework, e.g. nextjs"),
      hosting: choice(HOSTINGS, "Where the site is hosted"),
      changePolicy: choice(CHANGE_POLICIES, "What you may merge: merge_seo_scope = SEO-scope PRs, pr_only = none, full = any PR; agents may only lower it"),
    }),
  },
  { group: "Site repo", name: "get-site-link", displayName: "Get site link", description: "The sprint's site repo link, change policy and the exact SEO scope you may merge alone.", parametersSchema: schema(["sprintId"], { sprintId }) },
  {
    group: "Site repo",
    name: "check-change-scope",
    displayName: "Check change scope",
    description: "Before merging your PR: list every changed file with its SEO category and the check state. Returns merge, wait (checks not green) or pr_only (out of scope or policy pr_only → leave it open and add it to Needs you).",
    parametersSchema: schema(["sprintId", "changes"], {
      sprintId,
      changes: {
        type: "array",
        description: "Every changed file",
        items: {
          type: "object",
          required: ["path", "category"],
          properties: {
            path: text("The file's path in the repo"),
            category: choice([...SEO_SCOPE_CATEGORIES, "other"], "What the change is (SEO scope from get-site-link); other = not SEO scope"),
          },
        },
      },
      checks: choice(["passed", "failed", "pending"], "CI and preview deployment checks on the PR head commit"),
    }),
  },

  // Needs you
  { group: "Needs you", name: "needs-you", displayName: "Needs you digest", description: "This week's Needs you items for the sprint (open and done) and its issue.", parametersSchema: schema(["sprintId"], { sprintId }) },
  {
    group: "Needs you",
    name: "needs-you-add",
    displayName: "Add to Needs you",
    description: "Put something only a person can do on the sprint's weekly Needs you issue (deduped by key): an out-of-scope PR to merge (kind pr), a DM or email from a personal account with copy-ready text (kind message), a one-time grant. Say exactly what to do and what you do after. Standard keys github_token, site_project, service_account and bing_key fill in the exact steps and links themselves (pass taskIds; why = what failed).",
    parametersSchema: schema(["sprintId"], {
      sprintId,
      kind: choice(["grant", "review", "pr", "message", "task", "indexing"], "Item type (default grant): grant, review, pr (PR to merge), message (text to send), task or indexing"),
      key: text("Stable key for dedupe, e.g. pr:<url>; or a standard key: github_token, site_project, service_account, bing_key"),
      title: text("Short title (max 200 chars); required unless a standard key"),
      why: text("Why it is needed (max 2000 chars); required unless a standard key (github_token: what failed)"),
      steps: list("Exact steps"),
      links: list('"Label | https://…" or a bare URL'),
      copy: text("Copy-ready text (DM, email, post)"),
      after: text("What you do once it is done (required unless a standard key)"),
      taskIds: list("Tasks that continue when it is done"),
      optional: flag("Listed under Optional on the Needs you issue (default false)"),
    }),
  },
  { group: "Needs you", name: "needs-you-resolve", displayName: "Resolve Needs you item", description: "Mark an item done (when the person confirmed it). Checkable items (keys, access, repo link) are re-checked first; waiting tasks go back to you.", parametersSchema: schema(["sprintId", "key"], { sprintId, key: text("Item key (from needs-you)"), note: text("What was done, stored on the item (max 1000 chars)") }) },
  { group: "Needs you", name: "setup-checklist", displayName: "Setup checklist", description: "Every one-time setup item (settings, service account, GitHub access, agent, keys; per sprint: site repo, property, Bing, autopilot) with status, links and what you do next.", parametersSchema: schema([], { sprintId }) },

  // Audits
  { group: "Audits", name: "run-audit-snapshot", displayName: "Take audit snapshot", description: "Record traffic, rankings, authority, content, CWV and task counts now (day 0/30/60/90 and monthly snapshots happen automatically).", parametersSchema: schema(["sprintId"], { sprintId, day: int("Override the sprint day label"), notes: text("Notes stored with the snapshot (max 2000 chars)") }) },
  {
    group: "Audits",
    name: "record-finding",
    displayName: "Record audit finding",
    description: "Store a finding you found by hand.",
    parametersSchema: schema(["sprintId", "finding"], {
      sprintId,
      finding: text("What is wrong (max 1000 chars)"),
      severity: choice(FINDING_SEVERITIES, "How serious (default info)"),
      category: text("Area, e.g. meta, schema, links or cwv (default manual, max 40 chars)"),
      url: text("Page it is on: absolute URL or a path like /pricing"),
    }),
  },
  { group: "Audits", name: "resolve-finding", displayName: "Resolve finding", description: "Mark a finding fixed (checks also resolve their own findings when a re-run no longer reports them).", parametersSchema: schema(["findingId"], { findingId: text("Finding id (from audit-summary)") }) },
  { group: "Audits", name: "audit-summary", displayName: "Audit summary", description: "Snapshots over time, change from first to last, and open findings by severity and category.", parametersSchema: schema(["sprintId"], { sprintId }) },

  // Optimization
  { group: "Optimization", name: "detect-signals", displayName: "Detect SEO signals", description: "Run the detectors now and update sprint health. propose: true also records capped proposals and puts them on the owner's approval issue.", parametersSchema: schema(["sprintId"], { sprintId, propose: flag("Also record capped proposals on the owner's approval issue (default false)") }) },
  { group: "Optimization", name: "list-optimizations", displayName: "List optimizations", description: "Proposals and experiments with baseline, measure date, result, and the sprint scoreboard.", parametersSchema: schema(["sprintId"], { sprintId, status: choice(["proposed", "approved", "rejected", "measured"], "Only optimizations with this status") }) },
  { group: "Optimization", name: "approve-optimization", displayName: "Approve optimization", description: "People only (agents only when autopilot is full): creates the tasks for the current week, takes the baseline, schedules measurement in 14 days.", parametersSchema: schema(["optimizationId"], { optimizationId, note: text("Approver note added to the created tasks (max 2000 chars)") }) },
  { group: "Optimization", name: "reject-optimization", displayName: "Reject optimization", description: "Reject a proposal with a reason.", parametersSchema: schema(["optimizationId", "reason"], { optimizationId, reason: text("Why it is rejected (max 2000 chars)") }) },

  // Learned playbook
  {
    group: "Learned playbook",
    name: "get-playbook",
    displayName: "Get SEO playbook",
    description:
      "The learned playbook for a sprint's scope (one client, or Partners in Biz's own sites; shared by every sprint of that client): markdown rules kept from measured optimizations, its version, recent versions with reasons, and pending changes. Created on first use. Call it before working a sprint's tasks and follow it.",
    parametersSchema: schema([], {
      sprintId: text("Sprint id: the playbook of its scope (preferred)"),
      ...clientProps('Without sprintId: "own" for Partners in Biz\'s own sites, "company:<CRM company id>" or "contact:<CRM contact id>".'),
      includeVersionText: flag("Include each version's full markdown (default false)"),
    }),
  },
  {
    group: "Learned playbook",
    name: "propose-playbook-change",
    displayName: "Propose SEO playbook change",
    description:
      "Propose one edit to the scope's playbook with a reason: op add (section goal, rules, avoid, open or constraints; text = the rule, one line), remove (text = the exact line from get-playbook) or replace (playbook = the whole new markdown). Link the measured optimization it comes from. A person keeps or discards it unless the sprint's autopilot is full; agents cannot propose when autopilot is off.",
    parametersSchema: schema(["reason"], {
      sprintId: text("The sprint you learned it on (or pass optimizationId)"),
      op: choice(["add", "remove", "replace"], "add a line, remove a line, or replace the whole playbook (default add)"),
      section: choice(PLAYBOOK_SECTIONS, "For add; default rules. avoid = things that did not work"),
      text: text("add: the rule (max 400 chars, general enough to reuse); remove: the exact line"),
      playbook: text("replace: the whole new playbook markdown"),
      reason: text("Why, with the evidence (measured result, numbers)"),
      optimizationId: text("The measured optimization this comes from"),
    }),
  },
  {
    group: "Learned playbook",
    name: "decide-playbook-change",
    displayName: "Decide SEO playbook change",
    description: "Keep (writes a new playbook version) or discard a pending playbook change. Agents may only decide when the sprint's autopilot is full; otherwise a person decides from Needs you or SEO → Playbook.",
    parametersSchema: schema(["changeId", "decision"], {
      changeId: text("Pending change id (from get-playbook pendingChanges)"),
      decision: choice(["keep", "discard"], "keep writes a new playbook version; discard drops the change"),
      note: text("Decision note (max 1000 chars)"),
    }),
  },
];

/** Manifest form (without the doc-only `group`). */
export const SEO_TOOLS: PluginToolDeclaration[] = SEO_TOOL_DECLARATIONS.map(({ group: _group, ...tool }) => tool);
