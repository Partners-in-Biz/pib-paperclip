/**
 * Agent tool declarations (exposed as `partnersinbiz.seo:<name>`). The plugin
 * never writes content: tools are deterministic, except keyword intent, which
 * Jev classifies when a TypeSafe key is set (word rules otherwise).
 */
import type { JsonSchema, PluginToolDeclaration } from "@paperclipai/plugin-sdk";

const text = (description?: string): JsonSchema => (description ? { type: "string", description } : { type: "string" });
const int = (description?: string): JsonSchema => (description ? { type: "integer", description } : { type: "integer" });
const number = (description?: string): JsonSchema => (description ? { type: "number", description } : { type: "number" });
const flag = (description?: string): JsonSchema => (description ? { type: "boolean", description } : { type: "boolean" });
const list = (description?: string): JsonSchema => ({ type: "array", items: { type: "string" }, ...(description ? { description } : {}) });
const choice = (values: readonly string[], description?: string): JsonSchema => ({ type: "string", enum: [...values], ...(description ? { description } : {}) });

function schema(required: string[], properties: Record<string, JsonSchema>): JsonSchema {
  return { type: "object", required, properties, additionalProperties: false };
}

const sprintId = text("Sprint id (from list-sprints or today)");
const taskId = text("Task id (from today or list-tasks; also in the issue description)");
const urlOrSprint = {
  sprintId: text("Sprint id: records findings on the sprint and defaults the URL to the sprint site"),
  url: text("Absolute URL, or a path like /pricing when sprintId is given"),
};

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

export interface SeoToolDeclaration extends PluginToolDeclaration {
  /** Group used to render references/tools.md. */
  group: string;
}

export const SEO_TOOL_DECLARATIONS: SeoToolDeclaration[] = [
  // Sprints
  { group: "Sprints", name: "list-sprints", displayName: "List SEO sprints", description: "List sprints with client, day/week/phase, status, autopilot and task counts. Each sprint's `client` (null = Partners in Biz's own site) is what other tools take as `client`.", parametersSchema: schema([], { status: choice(["pre_launch", "active", "compounding", "paused", "archived"]), ...clientProps(CLIENT_FILTER) }) },
  {
    group: "Sprints",
    name: "create-sprint",
    displayName: "Create SEO sprint",
    description: "Start a 90-day sprint for one site: seeds the 42 Outrank-90 tasks and 15 directory backlinks, creates the sprint root issue in the SEO project, and opens the tasks that are already due. Omit client for Partners in Biz's own sites; for client work pass the CRM client (the name comes from the CRM).",
    parametersSchema: schema(["siteUrl"], {
      siteUrl: text("The site, e.g. https://example.co.za"),
      ...clientProps('Who the sprint is for: "company:<CRM company id>" or "contact:<CRM contact id>" (a sole trader). Omit for Partners in Biz\'s own sites.'),
      siteName: text("Display name for the site (default: the client name, or the domain for own sites)"),
      startDate: text("Day 0 (launch day), YYYY-MM-DD; default today"),
      ownerUserId: text("User who owns the sprint and receives human tasks; default: the person responsible for this run. 'none' for no owner"),
      autopilotMode: choice(["off", "safe"], "Agents may create sprints in off or safe mode only"),
      notes: text("Site access and constraints for the agent (repo, CMS, who deploys)"),
    }),
  },
  { group: "Sprints", name: "get-sprint", displayName: "Get SEO sprint", description: "One sprint with integrations, keyword counts, page health, snapshots and scoreboard.", parametersSchema: schema(["sprintId"], { sprintId }) },
  { group: "Sprints", name: "today", displayName: "Today's SEO plan", description: "What to do now: due, in-progress and blocked tasks (with issue ids), proposals, integration status and next steps, per sprint with its client. Omit sprintId for every active sprint (narrow with client).", parametersSchema: schema([], { sprintId, ...clientProps(CLIENT_FILTER) }) },
  { group: "Sprints", name: "set-autopilot", displayName: "Set sprint autopilot", description: "off: tasks go to the owner. safe: agent works its tasks; publish/send/deploy tasks need sign-off. full: no sign-off. Agents may only lower it.", parametersSchema: schema(["sprintId", "mode"], { sprintId, mode: choice(["off", "safe", "full"]) }) },
  { group: "Sprints", name: "update-sprint", displayName: "Update SEO sprint", description: "Change the site name or the notes the agent reads (site access, constraints). People only: move the sprint to another client or back to Partners in Biz's own sites.", parametersSchema: schema(["sprintId"], { sprintId, siteName: text(), notes: text(), ...clientProps('People only: "company:<CRM company id>", "contact:<CRM contact id>", or "own" for Partners in Biz\'s own sites.') }) },
  { group: "Sprints", name: "pause-sprint", displayName: "Pause SEO sprint", description: "Stop the daily run and new task issues for a sprint.", parametersSchema: schema(["sprintId"], { sprintId, reason: text() }) },
  { group: "Sprints", name: "resume-sprint", displayName: "Resume SEO sprint", description: "Resume a paused or archived sprint; its status follows the calendar again.", parametersSchema: schema(["sprintId"], { sprintId }) },
  { group: "Sprints", name: "archive-sprint", displayName: "Archive SEO sprint", description: "End a sprint. Nothing runs for it afterwards.", parametersSchema: schema(["sprintId"], { sprintId, reason: text() }) },
  { group: "Sprints", name: "post-digest", displayName: "Post SEO digest", description: "Post a digest comment on the sprint root issue: your summary plus today's completed and waiting tasks.", parametersSchema: schema(["sprintId", "summary"], { sprintId, summary: text("What you did, what moved, what is next — real numbers only") }) },

  // Tasks
  { group: "Tasks", name: "list-tasks", displayName: "List sprint tasks", description: "Tasks of a sprint with status and issue ids.", parametersSchema: schema(["sprintId"], { sprintId, status: list("Filter: not_started, in_progress, blocked, done, skipped, na"), week: int(), owner: choice(["agent", "human"]), source: choice(["template", "manual", "optimization"]), dueOnly: flag("Only tasks due by today") }) },
  { group: "Tasks", name: "start-task", displayName: "Start sprint task", description: "Mark a task in progress.", parametersSchema: schema(["taskId"], { taskId, note: text() }) },
  {
    group: "Tasks",
    name: "complete-task",
    displayName: "Complete sprint task",
    description: "Record evidence and close the task and its issue. Some task types check the sprint data first (keywords tracked, directories handled, day-90 snapshot). In safe mode, tasks that need sign-off are refused: use block-task with review: true.",
    parametersSchema: schema(["taskId", "summary"], {
      taskId,
      summary: text("What was done and the result"),
      links: list("PRs, commits, live URLs, drafts"),
      artifacts: { type: "array", items: { type: "object", properties: { label: text(), url: text(), value: text() }, required: ["label"] }, description: "Named outputs (e.g. 'new title', 'schema JSON-LD')" },
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
      links: list(),
    }),
  },
  { group: "Tasks", name: "skip-task", displayName: "Skip sprint task", description: "Mark a task skipped (not relevant for this site) with the reason; cancels its issue.", parametersSchema: schema(["taskId", "reason"], { taskId, reason: text() }) },
  {
    group: "Tasks",
    name: "add-task",
    displayName: "Add sprint task",
    description: "Add a manual task (default: this week, agent-owned) and open its issue if it is due.",
    parametersSchema: schema(["sprintId", "title"], {
      sprintId,
      title: text(),
      description: text(),
      taskType: text("Free-form type, default custom"),
      owner: choice(["agent", "human"]),
      week: int("Sprint week; default the current week"),
      autopilotEligible: flag("false = needs sign-off in safe mode"),
      createIssue: flag("default true"),
    }),
  },
  { group: "Tasks", name: "open-task", displayName: "Open sprint task (legacy)", description: "Legacy alias of add-task (owner defaults to human; site code changes stay agent work). Person tasks go on the Needs you issue.", parametersSchema: schema(["sprintId", "title"], { sprintId, title: text(), description: text(), owner: choice(["agent", "human"]) }) },

  // Keywords
  { group: "Keywords", name: "list-keywords", displayName: "List keywords", description: "Tracked keywords with current position, impressions, clicks, CTR, intent and target URL.", parametersSchema: schema(["sprintId"], { sprintId, includeRetired: flag() }) },
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
          properties: { phrase: text(), intent: choice(["problem", "solution", "brand"]), targetUrl: text(), volume: int("Only from a real source"), difficultyDr: int("Your DR estimate of the top results"), priority: flag(), notes: text() },
        },
      },
    }),
  },
  { group: "Keywords", name: "add-keyword", displayName: "Add keyword (legacy)", description: "Legacy alias: track one keyword.", parametersSchema: schema(["sprintId", "phrase"], { sprintId, phrase: text(), intent: choice(["problem", "solution", "brand"]), targetUrl: text() }) },
  { group: "Keywords", name: "update-keyword", displayName: "Update keyword", description: "Change intent, target URL, priority, DR estimate, volume or notes.", parametersSchema: schema(["keywordId"], { keywordId: text(), phrase: text(), intent: choice(["problem", "solution", "brand"]), targetUrl: text(), priority: flag(), difficultyDr: int(), volume: int(), notes: text() }) },
  { group: "Keywords", name: "retire-keyword", displayName: "Retire keyword", description: "Stop tracking a keyword (history is kept).", parametersSchema: schema(["keywordId"], { keywordId: text(), reason: text() }) },
  { group: "Keywords", name: "record-position", displayName: "Record keyword position", description: "Record a position you observed yourself (source manual). GSC positions arrive automatically each day.", parametersSchema: schema(["position"], { keywordId: text(), sprintId: text("With phrase, when you have no keywordId"), phrase: text(), position: number(), impressions: int(), clicks: int(), recordedOn: text("YYYY-MM-DD") }) },
  { group: "Keywords", name: "record-rank", displayName: "Record keyword rank (legacy)", description: "Legacy alias of record-position (no longer creates duplicate keywords).", parametersSchema: schema(["sprintId", "phrase"], { sprintId, phrase: text(), rank: int() }) },
  { group: "Keywords", name: "keyword-history", displayName: "Keyword position history", description: "Daily positions (GSC and manual) for one keyword, oldest first.", parametersSchema: schema(["keywordId"], { keywordId: text(), limit: int() }) },
  { group: "Keywords", name: "rank-history", displayName: "Keyword rank history (legacy)", description: "Legacy alias of keyword-history.", parametersSchema: schema(["keywordId"], { keywordId: text() }) },
  { group: "Keywords", name: "discover-keywords", displayName: "Discover keywords", description: "Google Autocomplete suggestions plus seed variants (alternative, vs, best, how to, for small business, pricing) with an intent (Jev when sure, else word rules; see intentSource). Suggestions only — nothing is saved.", parametersSchema: schema(["seeds"], { seeds: list("1–8 seed terms"), sprintId, limit: int(), country: text("Two-letter country for autocomplete, default za"), language: text("default en") }) },

  // Backlinks
  { group: "Backlinks", name: "list-backlinks", displayName: "List backlinks", description: "Backlinks and directory submissions with status.", parametersSchema: schema(["sprintId"], { sprintId, status: choice(["not_started", "in_progress", "submitted", "live", "rejected", "lost"]), type: choice(["directory", "community", "guest_post", "link_trade", "organic", "citation", "other"]) }) },
  { group: "Backlinks", name: "add-backlink", displayName: "Add backlink", description: "Track a link target or an earned link.", parametersSchema: schema(["sprintId", "domain"], { sprintId, domain: text(), source: text("Display name"), url: text("The linking or listing URL"), submitUrl: text(), type: choice(["directory", "community", "guest_post", "link_trade", "organic", "citation", "other"]), dr: int(), status: choice(["not_started", "in_progress", "submitted", "live", "rejected", "lost"]), notes: text() }) },
  { group: "Backlinks", name: "update-backlink", displayName: "Update backlink", description: "Move a backlink through submitted → live (or rejected/lost). Submitted/rejected/lost need notes; live needs the listing url.", parametersSchema: schema(["backlinkId"], { backlinkId: text(), status: choice(["not_started", "in_progress", "submitted", "live", "rejected", "lost"]), url: text(), submitUrl: text(), dr: int(), type: choice(["directory", "community", "guest_post", "link_trade", "organic", "citation", "other"]), notes: text() }) },

  // Content
  { group: "Content", name: "list-content", displayName: "List content", description: "Content pipeline with status, URLs, GSC impressions and pillar links.", parametersSchema: schema(["sprintId"], { sprintId, status: choice(["idea", "drafting", "review", "scheduled", "live", "archived"]), type: text() }) },
  { group: "Content", name: "add-content", displayName: "Add content", description: "Add a page or post to the pipeline.", parametersSchema: schema(["sprintId", "title"], { sprintId, title: text(), type: choice(["post", "page", "comparison", "alternative", "use-case", "pillar", "cluster", "how-to", "feature"]), status: choice(["idea", "drafting", "review", "scheduled", "live", "archived"]), targetKeywordId: text(), targetUrl: text(), publishOn: text("YYYY-MM-DD"), taskId: text(), notes: text() }) },
  { group: "Content", name: "update-content", displayName: "Update content", description: "Change status (live needs targetUrl), URL, keyword, internal links, or linksToPillarIds (ids of pillar content this item links to).", parametersSchema: schema(["contentId"], { contentId: text(), title: text(), type: text(), status: choice(["idea", "drafting", "review", "scheduled", "live", "archived"]), targetUrl: text(), targetKeywordId: text(), publishOn: text(), publishedOn: text(), internalLinksAdded: flag(), linksToPillarIds: list(), notes: text() }) },
  { group: "Content", name: "link-social-post", displayName: "Link social post", description: "Attach a Social plugin post (repurposed content) to a content item.", parametersSchema: schema(["contentId", "socialPostId"], { contentId: text(), socialPostId: text(), platform: text(), url: text() }) },
  { group: "Content", name: "add-page", displayName: "Track page (legacy)", description: "Track a URL for PageSpeed rotation.", parametersSchema: schema(["sprintId", "url"], { sprintId, url: text(), title: text() }) },

  // Site checks
  { group: "Site checks", name: "check-robots", displayName: "Check robots.txt", description: "Fetch and parse robots.txt: blocking rules for Googlebot/*, sitemaps.", parametersSchema: schema([], { ...urlOrSprint }) },
  { group: "Site checks", name: "check-sitemap", displayName: "Check sitemap", description: "Find (robots.txt or /sitemap.xml) and parse the sitemap or index, count URLs, spot-check a sample.", parametersSchema: schema([], { ...urlOrSprint, sitemapUrl: text(), sample: int("0–10 URLs to spot-check, default 5") }) },
  { group: "Site checks", name: "check-meta", displayName: "Check meta tags", description: "Title, description, h1, canonical, robots, Open Graph with length rules.", parametersSchema: schema([], { ...urlOrSprint }) },
  { group: "Site checks", name: "check-canonical", displayName: "Check canonical", description: "Canonical link/header vs the served URL.", parametersSchema: schema([], { ...urlOrSprint }) },
  { group: "Site checks", name: "validate-schema", displayName: "Validate structured data", description: "Extract and parse JSON-LD; report types, missing required properties and FAQ problems.", parametersSchema: schema([], { ...urlOrSprint }) },
  { group: "Site checks", name: "internal-link-audit", displayName: "Internal link audit", description: "Crawl up to 40 sitemap pages (20 s limit): inbound internal links per page, orphans, linked pages missing from the sitemap.", parametersSchema: schema([], { ...urlOrSprint, sitemapUrl: text(), maxPages: int("1–40, default 25") }) },
  { group: "Site checks", name: "crawler-sim", displayName: "Crawler view", description: "Fetch as Googlebot: status, redirects, robots.txt block, noindex (meta and X-Robots-Tag), canonical, h1, text size, images without alt, indexable yes/no.", parametersSchema: schema([], { ...urlOrSprint }) },
  { group: "Site checks", name: "run-pagespeed", displayName: "Run PageSpeed Insights", description: "PageSpeed Insights for one URL (up to ~25 s): scores, LCP/CLS/INP (field data when Google has it), top opportunities. Saved to page health with sprintId.", parametersSchema: schema([], { ...urlOrSprint, strategy: choice(["mobile", "desktop"]) }) },

  // GSC
  { group: "Google Search Console", name: "gsc-connect-url", displayName: "GSC access status", description: "How this sprint reaches Search Console: the service account (preferred; its email and next step) or the OAuth fallback page.", parametersSchema: schema(["sprintId"], { sprintId }) },
  {
    group: "Google Search Console",
    name: "gsc-verification-token",
    displayName: "GSC verification token",
    description: "Site Verification API: the exact meta tag (META) or file (FILE) for a URL-prefix site, or the DNS TXT record for a domain property, for the service account to become a verified owner. Add it through the site repo, then gsc-verify-site.",
    parametersSchema: schema(["sprintId"], { sprintId, method: choice(["META", "FILE", "DNS_TXT"], "Default META (URL-prefix); DNS_TXT for a domain property"), property: choice(["url", "domain"], "Default url"), taskId: text("The task this is for (resumed when a missing grant is added)") }),
  },
  {
    group: "Google Search Console",
    name: "gsc-verify-site",
    displayName: "Verify site with the service account",
    description: "Verify the token that is live on the site (the service account becomes a verified owner), add the Search Console property, store it on the sprint and submit <site>/sitemap.xml.",
    parametersSchema: schema(["sprintId"], { sprintId, method: choice(["META", "FILE", "DNS_TXT"]), submitSitemap: flag("default true") }),
  },
  {
    group: "Google Search Console",
    name: "gsc-check-access",
    displayName: "Check service account access",
    description: "Can the service account read this sprint's property? Selects it when yes. For client sites without access it puts the email (service account + Search Console Users link) on the Needs you issue.",
    parametersSchema: schema(["sprintId"], { sprintId, property: text("e.g. sc-domain:example.com; default: detected from the site"), askClient: flag("Queue the client email even for own sites"), taskId: text() }),
  },
  { group: "Google Search Console", name: "gsc-properties", displayName: "GSC properties", description: "Properties the connected Google account can see, the selected one and a suggestion.", parametersSchema: schema(["sprintId"], { sprintId }) },
  { group: "Google Search Console", name: "gsc-set-property", displayName: "Select GSC property", description: "Choose the property (e.g. sc-domain:example.com) used for this sprint.", parametersSchema: schema(["sprintId", "propertyUrl"], { sprintId, propertyUrl: text() }) },
  { group: "Google Search Console", name: "gsc-pull", displayName: "Pull GSC data", description: "Pull the last 8 days (to yesterday) now: tracked keyword positions (impression-weighted), clicks, CTR, content impressions and site totals. The daily run does this automatically.", parametersSchema: schema(["sprintId"], { sprintId }) },
  { group: "Google Search Console", name: "gsc-query", displayName: "Query GSC", description: "Page+query rows for the last N days, optionally filtered by position band, page or query text (e.g. positionMin 8, positionMax 20 for stuck pages).", parametersSchema: schema(["sprintId"], { sprintId, days: int("1–90, default 28"), positionMin: number(), positionMax: number(), page: text(), query: text("contains"), limit: int("default 100") }) },
  { group: "Google Search Console", name: "gsc-submit-sitemap", displayName: "Submit sitemap to GSC", description: "Submit a sitemap to the selected property (default <site>/sitemap.xml).", parametersSchema: schema(["sprintId"], { sprintId, sitemapUrl: text() }) },
  { group: "Google Search Console", name: "gsc-inspect-url", displayName: "Inspect URL in GSC", description: "URL Inspection: verdict, coverage, robots state, last crawl, Google vs declared canonical. (Google has no public request-indexing API; use request-indexing.)", parametersSchema: schema(["sprintId", "url"], { sprintId, url: text() }) },

  // Indexing and Bing
  { group: "Indexing and Bing", name: "indexnow-key", displayName: "IndexNow key", description: "The sprint's IndexNow key, the key file to add through the repo (public/<key>.txt), and whether it is live.", parametersSchema: schema(["sprintId"], { sprintId }) },
  {
    group: "Indexing and Bing",
    name: "request-indexing",
    displayName: "Get pages crawled",
    description: "Sitemap to Search Console, IndexNow ping (Bing and others; needs the live key file) and URL Inspection for up to 5 URLs (default: home + priority/live pages). The daily run re-inspects after 14 days and adds optional Search Console links to Needs you only for pages still not indexed.",
    parametersSchema: schema(["sprintId"], { sprintId, urls: list("Absolute URLs or paths; default the core pages"), sitemapUrl: text() }),
  },
  { group: "Indexing and Bing", name: "bing-add-site", displayName: "Add site to Bing", description: "Bing Webmaster API AddSite; returns BingSiteAuth.xml and the msvalidate.01 meta tag to add through the repo. Without an API key it puts the key on Needs you.", parametersSchema: schema(["sprintId"], { sprintId, siteUrl: text("default <site origin>/"), taskId: text() }) },
  { group: "Indexing and Bing", name: "bing-verify-site", displayName: "Verify site in Bing", description: "Bing VerifySite once BingSiteAuth.xml is live; enables Bing on the sprint and submits the sitemap.", parametersSchema: schema(["sprintId"], { sprintId, submitSitemap: flag("default true"), taskId: text() }) },
  { group: "Indexing and Bing", name: "bing-submit", displayName: "Submit to Bing", description: "SubmitSitemap and/or SubmitUrlBatch (up to 500 URLs).", parametersSchema: schema(["sprintId"], { sprintId, urls: list(), sitemapUrl: text(), taskId: text() }) },

  // Site repo
  { group: "Site repo", name: "list-site-projects", displayName: "List site projects", description: "Paperclip projects that could hold the site repo (repo URL from their workspace), best match first, plus how to create one.", parametersSchema: schema([], { sprintId }) },
  {
    group: "Site repo",
    name: "link-site",
    displayName: "Link site repo",
    description: "Link the Paperclip project whose workspace holds the site repo (code and content tasks open there), or noRepo: true for a CMS / client-managed site. Also sets branch, framework, hosting and the change policy (agents may only lower it).",
    parametersSchema: schema(["sprintId"], {
      sprintId,
      projectId: text(),
      noRepo: flag("No repo access: change sets go through Needs you"),
      unlink: flag("People only"),
      defaultBranch: text("default: from the workspace, else main"),
      framework: text("e.g. nextjs"),
      hosting: choice(["vercel", "netlify", "other"]),
      changePolicy: choice(["merge_seo_scope", "pr_only", "full"]),
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
        items: { type: "object", required: ["path", "category"], properties: { path: text(), category: choice(["head_metadata", "json_ld", "sitemap_robots", "verification_file", "image_alt", "internal_links", "new_content", "seo_redirect", "other"]) } },
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
      kind: choice(["grant", "review", "pr", "message", "task", "indexing"]),
      key: text("Stable key for dedupe, e.g. pr:<url>; or a standard key: github_token, site_project, service_account, bing_key"),
      title: text("Required unless a standard key"),
      why: text("Required unless a standard key"),
      steps: list("Exact steps"),
      links: list('"Label | https://…" or a bare URL'),
      copy: text("Copy-ready text (DM, email, post)"),
      after: text("What you do once it is done (required unless a standard key)"),
      taskIds: list("Tasks that continue when it is done"),
      optional: flag(),
    }),
  },
  { group: "Needs you", name: "needs-you-resolve", displayName: "Resolve Needs you item", description: "Mark an item done (when the person confirmed it). Checkable items (keys, access, repo link) are re-checked first; waiting tasks go back to you.", parametersSchema: schema(["sprintId", "key"], { sprintId, key: text(), note: text() }) },
  { group: "Needs you", name: "setup-checklist", displayName: "Setup checklist", description: "Every one-time setup item (settings, service account, GitHub access, agent, keys; per sprint: site repo, property, Bing, autopilot) with status, links and what you do next.", parametersSchema: schema([], { sprintId }) },

  // Audits
  { group: "Audits", name: "run-audit-snapshot", displayName: "Take audit snapshot", description: "Record traffic, rankings, authority, content, CWV and task counts now (day 0/30/60/90 and monthly snapshots happen automatically).", parametersSchema: schema(["sprintId"], { sprintId, day: int("Override the sprint day label"), notes: text() }) },
  { group: "Audits", name: "record-finding", displayName: "Record audit finding", description: "Store a finding you found by hand.", parametersSchema: schema(["sprintId", "finding"], { sprintId, finding: text(), severity: choice(["critical", "high", "medium", "low", "info"]), category: text(), url: text() }) },
  { group: "Audits", name: "record-audit", displayName: "Record audit finding (legacy)", description: "Legacy alias of record-finding.", parametersSchema: schema(["sprintId", "finding"], { sprintId, finding: text(), severity: text() }) },
  { group: "Audits", name: "resolve-finding", displayName: "Resolve finding", description: "Mark a finding fixed (checks also resolve their own findings when a re-run no longer reports them).", parametersSchema: schema(["findingId"], { findingId: text() }) },
  { group: "Audits", name: "audit-summary", displayName: "Audit summary", description: "Snapshots over time, change from first to last, and open findings by severity and category.", parametersSchema: schema(["sprintId"], { sprintId }) },

  // Optimization
  { group: "Optimization", name: "detect-signals", displayName: "Detect SEO signals", description: "Run the detectors now and update sprint health. propose: true also records capped proposals and puts them on the owner's approval issue.", parametersSchema: schema(["sprintId"], { sprintId, propose: flag() }) },
  { group: "Optimization", name: "list-optimizations", displayName: "List optimizations", description: "Proposals and experiments with baseline, measure date, result, and the sprint scoreboard.", parametersSchema: schema(["sprintId"], { sprintId, status: choice(["proposed", "approved", "rejected", "measured"]) }) },
  { group: "Optimization", name: "approve-optimization", displayName: "Approve optimization", description: "People only (agents only when autopilot is full): creates the tasks for the current week, takes the baseline, schedules measurement in 14 days.", parametersSchema: schema(["optimizationId"], { optimizationId: text(), note: text() }) },
  { group: "Optimization", name: "reject-optimization", displayName: "Reject optimization", description: "Reject a proposal with a reason.", parametersSchema: schema(["optimizationId", "reason"], { optimizationId: text(), reason: text() }) },
];

/** Manifest form (without the doc-only `group`). */
export const SEO_TOOLS: PluginToolDeclaration[] = SEO_TOOL_DECLARATIONS.map(({ group: _group, ...tool }) => tool);
