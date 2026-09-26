/**
 * Agent tool declarations (exposed as `partnersinbiz.seo:<name>`). The plugin
 * never calls a model: every tool is deterministic; the agent does the thinking.
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

export interface SeoToolDeclaration extends PluginToolDeclaration {
  /** Group used to render references/tools.md. */
  group: string;
}

export const SEO_TOOL_DECLARATIONS: SeoToolDeclaration[] = [
  // Sprints
  { group: "Sprints", name: "list-sprints", displayName: "List SEO sprints", description: "List sprints with day/week/phase, status, autopilot and task counts.", parametersSchema: schema([], { status: choice(["pre_launch", "active", "compounding", "paused", "archived"]), clientRef: text("CRM company id") }) },
  {
    group: "Sprints",
    name: "create-sprint",
    displayName: "Create SEO sprint",
    description: "Start a 90-day sprint for one site: seeds the 42 Outrank-90 tasks and 15 directory backlinks, creates the sprint root issue in the SEO project, and opens the tasks that are already due.",
    parametersSchema: schema(["siteUrl"], {
      siteUrl: text("The site, e.g. https://example.co.za"),
      clientRef: text("CRM company id of the client (preferred)"),
      clientName: text("Client name when there is no CRM company"),
      siteName: text("Display name for the site"),
      startDate: text("Day 0 (launch day), YYYY-MM-DD; default today"),
      ownerUserId: text("User who owns the sprint and receives human tasks; default: the person responsible for this run. 'none' for no owner"),
      autopilotMode: choice(["off", "safe"], "Agents may create sprints in off or safe mode only"),
      notes: text("Site access and constraints for the agent (repo, CMS, who deploys)"),
    }),
  },
  { group: "Sprints", name: "get-sprint", displayName: "Get SEO sprint", description: "One sprint with integrations, keyword counts, page health, snapshots and scoreboard.", parametersSchema: schema(["sprintId"], { sprintId }) },
  { group: "Sprints", name: "today", displayName: "Today's SEO plan", description: "What to do now: due, in-progress and blocked tasks (with issue ids), proposals, integration status and next steps. Omit sprintId for every active sprint.", parametersSchema: schema([], { sprintId }) },
  { group: "Sprints", name: "set-autopilot", displayName: "Set sprint autopilot", description: "off: tasks go to the owner. safe: agent works its tasks; publish/send/deploy tasks need sign-off. full: no sign-off. Agents may only lower it.", parametersSchema: schema(["sprintId", "mode"], { sprintId, mode: choice(["off", "safe", "full"]) }) },
  { group: "Sprints", name: "update-sprint", displayName: "Update SEO sprint", description: "Change the site name or the notes the agent reads (site access, constraints).", parametersSchema: schema(["sprintId"], { sprintId, siteName: text(), notes: text() }) },
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
    description: "Blocked (review false) or ready for sign-off (review true): comments the precise ask on the issue and hands it to the sprint owner.",
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
  { group: "Tasks", name: "open-task", displayName: "Open sprint task (legacy)", description: "Legacy alias of add-task for work a person must do (owner defaults to human).", parametersSchema: schema(["sprintId", "title"], { sprintId, title: text(), description: text(), owner: choice(["agent", "human"]) }) },

  // Keywords
  { group: "Keywords", name: "list-keywords", displayName: "List keywords", description: "Tracked keywords with current position, impressions, clicks, CTR, intent and target URL.", parametersSchema: schema(["sprintId"], { sprintId, includeRetired: flag() }) },
  {
    group: "Keywords",
    name: "add-keywords",
    displayName: "Add keywords",
    description: "Track keywords in bulk (duplicates are skipped). Never invent volume.",
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
  { group: "Keywords", name: "discover-keywords", displayName: "Discover keywords", description: "Google Autocomplete suggestions plus seed variants (alternative, vs, best, how to, for small business, pricing) with an intent guess. Suggestions only — nothing is saved.", parametersSchema: schema(["seeds"], { seeds: list("1–8 seed terms"), sprintId, limit: int(), country: text("Two-letter country for autocomplete, default za"), language: text("default en") }) },

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
  { group: "Google Search Console", name: "gsc-connect-url", displayName: "GSC connect link", description: "Connection status and the Paperclip page link a person uses to connect Search Console (the OAuth must happen in their browser).", parametersSchema: schema(["sprintId"], { sprintId }) },
  { group: "Google Search Console", name: "gsc-properties", displayName: "GSC properties", description: "Properties the connected Google account can see, the selected one and a suggestion.", parametersSchema: schema(["sprintId"], { sprintId }) },
  { group: "Google Search Console", name: "gsc-set-property", displayName: "Select GSC property", description: "Choose the property (e.g. sc-domain:example.com) used for this sprint.", parametersSchema: schema(["sprintId", "propertyUrl"], { sprintId, propertyUrl: text() }) },
  { group: "Google Search Console", name: "gsc-pull", displayName: "Pull GSC data", description: "Pull the last 8 days (to yesterday) now: tracked keyword positions (impression-weighted), clicks, CTR, content impressions and site totals. The daily run does this automatically.", parametersSchema: schema(["sprintId"], { sprintId }) },
  { group: "Google Search Console", name: "gsc-query", displayName: "Query GSC", description: "Page+query rows for the last N days, optionally filtered by position band, page or query text (e.g. positionMin 8, positionMax 20 for stuck pages).", parametersSchema: schema(["sprintId"], { sprintId, days: int("1–90, default 28"), positionMin: number(), positionMax: number(), page: text(), query: text("contains"), limit: int("default 100") }) },
  { group: "Google Search Console", name: "gsc-submit-sitemap", displayName: "Submit sitemap to GSC", description: "Submit a sitemap to the selected property (default <site>/sitemap.xml).", parametersSchema: schema(["sprintId"], { sprintId, sitemapUrl: text() }) },
  { group: "Google Search Console", name: "gsc-inspect-url", displayName: "Inspect URL in GSC", description: "URL Inspection: verdict, coverage, robots state, last crawl, Google vs declared canonical. Cannot request indexing.", parametersSchema: schema(["sprintId", "url"], { sprintId, url: text() }) },

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
