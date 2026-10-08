/**
 * Agent tool declarations (exposed as `partnersinbiz.seo:<name>`). The plugin
 * never writes content: tools are deterministic, except keyword intent, which
 * Jev classifies when a TypeSafe key is set (word rules otherwise).
 *
 * Every parameter has a one-line description and fixed values are enums
 * (tests/tool-params.spec.ts checks both).
 */
import type { JsonSchema, PluginToolDeclaration } from "@paperclipai/plugin-sdk";
import { AI_ENGINES } from "./engine/geo.js";
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
    description: "Start a 90-day sprint for one site: seeds the plan for its business type (42–46 tasks and 13–15 directories or citations; AI search, Google Analytics and page groups start off, a person turns them on), creates the sprint root issue in the SEO project, and opens the tasks that are already due. Omit client for Partners in Biz's own sites; for client work pass the CRM client (the name comes from the CRM) and the businessType that fits it. A fixture site (host ending .invalid) or the canary client makes a rehearsal sprint: its plan and tasks exist to read, but no issue is ever opened and nobody is asked for anything (the answer says rehearsal: true).",
    parametersSchema: schema(["siteUrl"], {
      siteUrl: text("The site, e.g. https://example.co.za"),
      ...clientProps('Who the sprint is for: "company:<CRM company id>" or "contact:<CRM contact id>" (a sole trader). Omit for Partners in Biz\'s own sites.'),
      siteName: text("Display name for the site (default: the client name, or the domain for own sites)"),
      businessType: choice(BUSINESS_TYPES, `${BUSINESS_TYPE_TEXT}; default local for a client, saas for own sites`),
      startDate: text("Day 0 (launch day), YYYY-MM-DD; default today"),
      ownerUserId: text("User who owns the sprint and receives human tasks; default: the person responsible for this run. 'none' for no owner"),
      autopilotMode: choice(["off", "safe"], "Agents may create sprints in off or safe mode only"),
      pacing: choice(["auto", "manual"], "auto (default): plan tasks open by the calendar. manual: nothing opens until a person starts each week on the SEO page; use it only when the owner asked for it"),
      notes: text("Site access and constraints for the agent (repo, CMS, who deploys)"),
    }),
  },
  { group: "Sprints", name: "get-sprint", displayName: "Get SEO sprint", description: "One sprint with integrations, keyword counts, page health, snapshots and scoreboard.", parametersSchema: schema(["sprintId"], { sprintId }) },
  {
    group: "Sprints",
    name: "get-switches",
    displayName: "Which extras are on",
    description: "Read only. The extras a person can switch on per sprint (AI search, Google Analytics, page groups), which are on for a sprint (or for every sprint in a scope) and what new sprints start with. All are off until a person turns them on; you cannot change them, and the tools of an extra that is off refuse and change nothing.",
    parametersSchema: schema([], { sprintId: text("Sprint id: its switches and who changed them. Omit for every sprint (narrow with client)"), ...clientProps(CLIENT_FILTER) }),
  },
  { group: "Sprints", name: "today", displayName: "Today's SEO plan", description: "What to do now: due, in-progress and blocked tasks (with issue ids), proposals, integration status and next steps, per sprint with its client. Omit sprintId for every active sprint, rehearsal sprints excepted (narrow with client).", parametersSchema: schema([], { sprintId, ...clientProps(CLIENT_FILTER) }) },
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
  { group: "Sprints", name: "archive-sprint", displayName: "Archive SEO sprint", description: "End a sprint. Nothing runs for it afterwards. On a rehearsal sprint it also cancels any issue the sprint still has.", parametersSchema: schema(["sprintId"], { sprintId, reason: text("Why it ends, posted on the sprint root issue (max 1000 chars)") }) },
  { group: "Sprints", name: "post-digest", displayName: "Post SEO digest", description: "Once a day: post a short digest (under 1,000 characters) on the sprint root issue: your summary plus today's completed and waiting tasks. Full task reports belong on the task issue.", parametersSchema: schema(["sprintId", "summary"], { sprintId, summary: text("What you did, what moved, what is next — real numbers only") }) },

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
  {
    group: "Tasks",
    name: "compact-task-thread",
    displayName: "Move a long task thread to a fresh issue",
    description:
      "A task issue whose thread has grown past about 60 KB cannot be handed to an agent (the run fails with spawn E2BIG). This moves the task to a continuation issue (same project, parent, assignee and checkout, the task's description plus a summary of where it stands), points the task and its previews at it, closes the old issue with a pointer and wakes the agent there. The plugin does this by itself every few minutes; call it to do it now. It only reports unless dryRun is false.",
    parametersSchema: schema([], {
      issueId: text("Move just this task issue: its id or identifier such as PAR-528. Omit to check every open task issue of the company"),
      taskId: text("Move just this task (from list-tasks)"),
      dryRun: flag("Default true: only report which issues would move. Pass false to move them"),
      minBytes: int("Thread size in bytes that counts as too long (default 60000, at least 10000); lower it to move a smaller thread"),
    }),
  },
  {
    group: "Tasks",
    name: "split-task",
    displayName: "Split a site-wide task into page groups",
    description:
      "Only on a sprint a person switched page groups on for (get-switches); otherwise it refuses and changes nothing. A site-wide task (a title and description for every page, alt text, noindex, canonicals) on a site with more pages than one run can do well is split into child issues of N pages, opened one at a time; the plugin does this when the task's issue opens or when you start-task it. Call it yourself on an open task that was not split. After it splits the task, end your run: the pages are the group issues' work, you are woken on the task when the last group is done, and complete-task then checks the site as a whole.",
    parametersSchema: schema(["taskId"], {
      taskId,
      size: int("Pages per group, 5 to 50 (default by task type: 10 for titles and alt text, 25 for canonicals, 40 for noindex)"),
      urls: list("Split exactly these pages instead of the sitemap's (up to 400)"),
      dryRun: flag("true = show the plan and open nothing (default false)"),
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
  {
    group: "Tasks",
    name: "request-build",
    displayName: "Hand a build to a developer",
    description:
      "Hand the BUILDING of a change to a developer agent and wait for their report. You decide what the page should say; the Developer builds page templates, theme or markup changes, schema code, redirects, internal-link code and repo changes (Senior Developer for theme or template work, many pages, ecommerce or anything tricky: level senior). Send the task, a summary, and the exact change set (pages, fields, old and new values or the full copy). On a site that needs the client's sign-off, send previewId of an APPROVED preview. It opens a build issue under the task for them and wakes them; end your turn. You are woken when it is done: verify it on the live site and complete the task. Copy, titles, descriptions, keyword choices and the checks stay yours.",
    parametersSchema: schema(["sprintId", "taskId", "summary", "changeSet"], {
      sprintId,
      taskId: text("The SEO task this build is for (from list-tasks)."),
      summary: text("What to build and why, in a few sentences."),
      changeSet: text("The exact change: each page or file, the field, old value, new value, or the full copy and structure."),
      acceptance: text("How you will check it is right (checks you will run, what must be true)."),
      previewId: text("Id of the client-approved preview (from list-previews). Required on sites that need client sign-off."),
      level: choice(["developer", "senior"], "senior = Senior Developer for theme or template work, many pages, ecommerce or anything tricky (default developer)"),
    }),
  },
  {
    group: "Tasks",
    name: "start-tasks-now",
    displayName: "Start tasks early",
    description:
      "Pull upcoming plan tasks forward: send taskId (one task) or week (every task of that week that has not started) and they become due today with their issues opened, instead of waiting for their day. The plan does not move otherwise. People decide the pace (the Start now buttons on the SEO plan); an agent may only use it when the sprint's autopilot is full, and never on a sprint on manual pacing (get-sprint shows pacing): there only a person starts a week. Works on tasks that have not started; up to 25 per call.",
    parametersSchema: schema(["sprintId"], {
      sprintId,
      taskId: text("One task to start now (from list-tasks)."),
      week: int("Start every not-started task of this plan week now (0 to 13)."),
    }),
  },

  {
    group: "Site",
    name: "create-preview",
    displayName: "Create a client preview link",
    description:
      "Make a link the client can open to see proposed copy on their own page before anything is live. Use it for every WordPress change on a pr_only sprint: send the page (pageUrl, must be on the sprint's site) and the proposed title, metaDescription, h1 and/or bodyHtml (the main content, plain HTML: headings, paragraphs, lists, links, images). The server shows your copy on top of the live page with a 'Proposed, not live' bar and Approve / Request changes buttons. Copy is ADDED to the page (before or after the existing content); the preview is refused if it would lose over 30% of the live page's text. Every preview is held until the Reviewer has compared it with the live page: end your turn, you are woken with the result, and only then give the owner the link. Nothing is changed on the site. Existing pages only; the link expires after 30 days.",
    parametersSchema: schema(["sprintId", "pageUrl"], {
      sprintId,
      pageUrl: text("The live page to preview a change on: a full URL or a path like /about on the sprint's site."),
      taskId: text("The task this is for (from list-tasks); the client's answer is posted on its issue."),
      title: text("Proposed <title> (about 50-60 characters)."),
      metaDescription: text("Proposed meta description (about 150-160 characters)."),
      h1: text("Proposed H1. Replaces the page's own H1 inside the content; a theme heading elsewhere is never touched (the new one goes at the top of the content)."),
      bodyHtml: text("Copy to ADD to the page, as plain HTML (headings, paragraphs, lists, links). It is added to the existing content, never instead of it, unless bodyMode is replace."),
      bodyMode: choice(["before", "after", "replace"], "before (default, above the existing content), after (below it) or replace (whole content area; needs allowReplace)"),
      css: text("Redesign tasks only: styles shown on the preview (colours, fonts, spacing, layout). Imports, scripts and event handlers are removed."),
      allowReplace: flag("With bodyMode replace only: you really are rewriting the whole page (say why in the summary)"),
      why: text("One sentence for the client, under this page in their approval email: why we changed it and how it should help search. Say should or helps; never promise a result."),
      label: text("Short name for the proposal, shown on the Needs you item."),
    }),
  },
  {
    group: "Site",
    name: "review-preview",
    displayName: "Record a preview check",
    description:
      "For the Reviewer: after opening the review page of a client preview (side-by-side screenshots of the live page and the proposal, plus the text figures) and looking at both screenshots, record the verdict. pass releases the link to the client; changes (with notes, one line per problem) sends it back to the SEO Specialist and the client never sees it. With changes, say who fixes it (fixBy): the SEO Specialist for wording and facts, a developer for markup, styling or layout problems (the plugin then opens the build for them and they make the corrected preview), the Senior Developer for theme or template work. You cannot check a preview you made yourself.",
    parametersSchema: schema(["sprintId", "previewId", "verdict"], {
      sprintId,
      previewId: text("The preview id (from the review issue)."),
      verdict: choice(["pass", "changes"], "pass = fine to show the client; changes = send back"),
      notes: text("What you checked and found; required with changes."),
      fixBy: choice(["seo", "developer", "senior"], "With changes: who fixes it. seo = wording or facts; developer = markup, styling, layout; senior = theme or template work"),
    }),
  },
  {
    group: "Sprints",
    name: "draft-progress-report",
    displayName: "Draft an SEO progress email",
    description:
      "Drafts, in the company's Gmail Drafts, an email to a client's owner about the sprints you name: per site what was done in weeks 0 to 3, the pages written and approved, what is still open and for whom, and what the plan does in weeks 4 to 7. The plugin writes it from the sprints' own records (nothing free-form), never sends it, and a person reads and sends it. Use it only when a person asked for a progress email.",
    parametersSchema: schema(["sprintIds", "to"], {
      sprintIds: list("The sprints the email covers (list-sprints gives the ids), at most 10"),
      to: list("Who the draft is addressed to: one to five email addresses"),
      greetingName: text("First name for the greeting, for example Pieter"),
    }),
  },
  {
    group: "Site",
    name: "propose-client-facts",
    displayName: "Add wordings from the client's own pages to the fact sheet",
    description:
      "When create-preview refuses a claim because the fact sheet does not cover it, find where the client says it themselves (their terms, delivery, returns, FAQ or about page) and add it here: copy the sentence EXACTLY from that page and send the page's address. The plugin fetches the page and refuses any wording that is not on it, so nothing is invented. Accepted wordings join the sheet as a draft the owner can confirm later; copy may use them (shortened is fine, reworded is not). If the client does not say it anywhere, leave the claim out of the copy. Up to 20 per call.",
    parametersSchema: schema(["sprintId", "say"], {
      sprintId,
      say: {
        type: "array",
        items: {
          type: "object",
          properties: {
            wording: text("The sentence, copied exactly from the client's page (at least 12 characters)"),
            sourceUrl: text("The client's page it is on: absolute URL or a path like /delivery"),
          },
          required: ["wording", "sourceUrl"],
        },
        description: "Wordings to approve, each with the page it comes from",
      },
    }),
  },
  {
    group: "Site",
    name: "get-client-facts",
    displayName: "Read the client fact sheet",
    description:
      "Read it BEFORE writing copy for a client. It lists the approved wordings the copy may use for claims about how the business works (bidding, ownership, reserves, fees, delivery, guarantees, inspection, verification, licences, legal wording, refunds, time commitments) and what must never be said. create-preview refuses a sentence that makes such a claim without an approved wording; the Reviewer checks against it. If a fact you need is missing, ask the owner (Needs you); never invent or reword one.",
    parametersSchema: schema(["sprintId"], { sprintId }),
  },
  {
    group: "Site",
    name: "list-previews",
    displayName: "List client previews",
    description:
      "Previews made for a sprint, newest first, as short rows (id, page, status, review status, and the client's and the Reviewer's notes cut short). The default is the 20 newest; narrow with taskId, status or reviewStatus, or pass previewId for one preview in full (link, whole notes, figures, review link). Check it before applying a change: apply only what the owner has confirmed as approved.",
    parametersSchema: schema(["sprintId"], {
      sprintId,
      previewId: text("One preview id: returns just that preview with every field in full (whole notes, figures, review link)"),
      taskId: text("Only the previews made for this task"),
      status: choice(["pending", "approved", "changes_requested"], "Only previews with this client answer: pending, approved or changes_requested"),
      reviewStatus: choice(["pending", "passed", "changes_needed"], "Only previews with this Reviewer verdict: pending, passed or changes_needed"),
      limit: int("Rows to return (default 20, at most 100)"),
      compact: flag("Short rows (default true); false returns every field in full for each row"),
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
  {
    group: "Site checks",
    name: "page-diff",
    displayName: "Diff gate: what a changed page lost",
    description:
      "Compare the live page with the changed version (a preview or staging address, or its HTML) and list every element the old page had that the new one does not: headings, tables and table rows, lists, images, forms, embeds, internal links, structured data types, the title and the meta description. Read only. Run it before any page change goes to review or is merged; every lost element must be restored or named as removed on purpose.",
    parametersSchema: schema(["url"], {
      sprintId: text("Sprint id (optional): paths like /about are read against the sprint's site"),
      url: text("The live page: a full URL or a path like /about"),
      afterUrl: text("The changed page: its preview or staging address"),
      afterHtml: text("The changed page's HTML, when it has no address yet (at most 600,000 characters)"),
    }),
  },
  {
    group: "Site checks",
    name: "page-for-keyword",
    displayName: "Optimise, merge or create? (one keyword, one page)",
    description:
      "Before writing any page for a keyword: read the last 90 days of Search Console for that exact keyword and say whether a page already earns it (optimise that page), two pages fight for it (merge them) or nothing does (create). With an existing page it also lists that page's other top-5 queries, which are its secondary keywords. Read only; needs Search Console connected.",
    parametersSchema: schema(["sprintId", "keyword"], { sprintId, keyword: text("The exact keyword to write for") }),
  },
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
    description: "Site Verification API: the exact meta tag (META) or file (FILE) for a URL-prefix site, or the DNS TXT record for a domain property, for the service account to become a verified owner. Add it through the site repo, or on a WordPress site with a Connector 1.2+ through the CRM's wp-verify (op get, then op set with the existing entries plus metaTags [{ name: \"google-site-verification\", content }] or the file; the result carries the exact call), check it on the live site, then gsc-verify-site.",
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
    description: "Verify the token that is live on the site (repo route: after the deploy; WordPress route: after wp-verify set; the service account becomes a verified owner of the URL-prefix property, so the client grants nothing), add the Search Console property, store it on the sprint and submit <site>/sitemap.xml.",
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
    description: "Can the service account read this sprint's property? Selects it when yes. WordPress sprint with a connected Connector 1.2+: it does NOT email the client first; it returns the exact route (gsc-verification-token method META property url → wp-verify set → gsc-verify-site), and only queues the client email (service account + Search Console Users link) on the Needs you issue after that route failed (gsc-verify-site records the failure on the sprint). A Connector older than 1.2: it tells you to run the CRM's wp-connector update first. Repo and no-repo client sites: the email is queued as before.",
    parametersSchema: schema(["sprintId"], {
      sprintId,
      property: text("Property to check, e.g. sc-domain:example.com; default: detected from the site"),
      askClient: flag("Queue the client email even for own sites (ignored on a WordPress site whose wp-verify route has not failed yet)"),
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
  { group: "Indexing and Bing", name: "indexnow-key", displayName: "IndexNow key", description: "The sprint's IndexNow key, the key file to add and whether it is live. Repo: public/<key>.txt. WordPress with a Connector 1.2+: the CRM's wp-verify op set files [{ path: \"/<key>.txt\", content: \"<key>\" }] (op get first, it replaces the list); confirm with this tool again (it fetches the file), then request-indexing. Never a Needs you item on such a site.", parametersSchema: schema(["sprintId"], { sprintId }) },
  {
    group: "Indexing and Bing",
    name: "request-indexing",
    displayName: "Get pages crawled",
    description: "Sitemap to Search Console, IndexNow ping (Bing and others; needs the live key file) and URL Inspection for up to 5 URLs (default: home + priority/live pages). The steps run in parallel and the call returns after waitSeconds (default 8, inside the gateway's 10 s) with whatever finished: a step that did not answer is marked timedOut / pending, never an error for the whole call. URL Inspection takes several seconds per page. The daily run re-inspects after 14 days and adds optional Search Console links to Needs you only for pages still not indexed.",
    parametersSchema: schema(["sprintId"], {
      sprintId,
      urls: list("Absolute URLs or paths; default the core pages"),
      sitemapUrl: text("Sitemap URL or path to submit (default <site origin>/sitemap.xml)"),
      inspect: flag("Run URL Inspection on the URLs (default true); false = sitemap and IndexNow only"),
      waitSeconds: int("Seconds to wait for the steps (1-50, default 8). Raise it together with the gateway call's timeoutMs when you want every inspection to finish."),
    }),
  },
  { group: "Indexing and Bing", name: "bing-add-site", displayName: "Add site to Bing", description: "Bing Webmaster API AddSite; returns BingSiteAuth.xml and the msvalidate.01 meta tag to add through the repo, or on a WordPress site with a Connector 1.2+ through the CRM's wp-verify (metaTags [{ name: \"msvalidate.01\", content }] or files [{ path: \"/BingSiteAuth.xml\", content }]; the result carries the call). Without an API key it puts the key on Needs you.", parametersSchema: schema(["sprintId"], { sprintId, siteUrl: text("Site URL to add in Bing (default <site origin>/)"), taskId: bingTaskId }) },
  { group: "Indexing and Bing", name: "bing-verify-site", displayName: "Verify site in Bing", description: "Bing VerifySite once BingSiteAuth.xml or the msvalidate.01 tag is live (repo deploy, or wp-verify set on a WordPress site; fetch it on the live site first); enables Bing on the sprint and submits the sitemap.", parametersSchema: schema(["sprintId"], { sprintId, submitSitemap: flag("Also submit <site origin>/sitemap.xml to Bing (default true)"), taskId: bingTaskId }) },
  { group: "Indexing and Bing", name: "bing-submit", displayName: "Submit to Bing", description: "SubmitSitemap and/or SubmitUrlBatch (up to 500 URLs).", parametersSchema: schema(["sprintId"], { sprintId, urls: list("URLs or paths to submit (max 500)"), sitemapUrl: text("Sitemap URL or path to submit; without urls, default <site origin>/sitemap.xml"), taskId: bingTaskId }) },

  // Site repo
  { group: "Site repo", name: "list-site-projects", displayName: "List site projects", description: "Paperclip projects that could hold the site repo (repo URL from their workspace), best match first, plus how to create one. With sprintId also the client's WordPress sites from the CRM (wordpressSites: siteId, url, summary, Connector status) for wordpress mode.", parametersSchema: schema([], { sprintId }) },
  {
    group: "Site repo",
    name: "link-site",
    displayName: "Link site repo",
    description: "Link the client's own Paperclip project (clientProjectId: all this sprint's issues open there) and/or the Paperclip project whose workspace holds the site repo (code and content tasks open there), wordpressSiteId for a client's WordPress site reached through the PiB Connector (changes through the partnersinbiz.crm:wp-* tools), or noRepo: true for a CMS / client-managed site without the Connector. Also sets branch, framework, hosting and the change policy (agents may only lower it).",
    parametersSchema: schema(["sprintId"], {
      sprintId,
      projectId: text("Paperclip project whose workspace holds the site repo (from list-site-projects)"),
      clientProjectId: text("The client's own Paperclip project (from list-site-projects): all issues of this sprint open there. Auto-linked when a project is named like the client"),
      wordpressSiteId: text("CRM website id of the sprint client's WordPress site (from list-site-projects wordpressSites): wordpress mode, changes through the PiB Connector"),
      noRepo: flag("No repo access: change sets go through Needs you"),
      unlink: flag("Remove the site link, back to unlinked (people only)"),
      defaultBranch: text("Branch PRs target and work starts from. Default: the project's work branch (its workspace policy base ref, e.g. development), else the workspace default, else main"),
      framework: text("Site framework, e.g. nextjs"),
      hosting: choice(HOSTINGS, "Where the site is hosted"),
      changePolicy: choice(CHANGE_POLICIES, "What you may merge: merge_seo_scope = SEO-scope PRs, pr_only = none, full = any PR; agents may only lower it"),
    }),
  },
  { group: "Site repo", name: "get-site-link", displayName: "Get site link", description: "The sprint's site link (repo project, WordPress site through the PiB Connector, or none), change policy, the exact SEO scope you may merge or apply alone, and what to do next.", parametersSchema: schema(["sprintId"], { sprintId }) },
  {
    group: "Site repo",
    name: "check-change-scope",
    displayName: "Check change scope",
    description: "Before merging your PR: list every changed file with its SEO category and the check state. Returns merge, wait (checks not green) or pr_only (out of scope or policy pr_only → leave it open and add it to Needs you). On a WordPress sprint list each Connector change (path wp:<area>:<target>, e.g. wp:seo:/about) instead: returns apply (make it yourself, then verify live) or pr_only (change set on Needs you).",
    parametersSchema: schema(["sprintId", "changes"], {
      sprintId,
      changes: {
        type: "array",
        description: "Every changed file",
        items: {
          type: "object",
          required: ["path", "category"],
          properties: {
            path: text("The file's path in the repo; on a WordPress sprint wp:<area>:<target>, e.g. wp:seo:/about, wp:schema:site/localbusiness, wp:redirects:/old-page"),
            category: choice([...SEO_SCOPE_CATEGORIES, "other"], "What the change is (SEO scope from get-site-link); other = not SEO scope"),
          },
        },
      },
      checks: choice(["passed", "failed", "pending"], "CI and preview deployment checks on the PR head commit (not used on WordPress sprints)"),
    }),
  },

  // Needs you
  {
    group: "Needs you",
    name: "needs-you",
    displayName: "Needs you digest",
    description:
      "This week's Needs you items for the sprint and its issue. The default is short: each open item with its key, title, kind, task ids and a one-line why (up to 30), and the keys of the done ones. Pass key for one item in full (steps, links, copy-ready text), or compact false for every item in full.",
    parametersSchema: schema(["sprintId"], {
      sprintId,
      key: text("One item key (from this tool): returns that item in full, open or done"),
      compact: flag("Short items (default true); false returns every open and done item in full"),
      limit: int("Open items to return (default 30, at most 100)"),
    }),
  },
  {
    group: "Needs you",
    name: "needs-you-add",
    displayName: "Add to Needs you",
    description: "Put something only a person can do on the sprint's weekly Needs you issue (never Search Console, Bing or IndexNow verification on a WordPress site with the Connector: wp-verify does that, and this tool refuses it unless wpVerifyFailed says what failed) (deduped by key): an out-of-scope PR to merge (kind pr), a DM or email from a personal account with copy-ready text (kind message), a one-time grant. Say exactly what to do and what you do after. Standard keys github_token, site_project, service_account, bing_key and wp_connector fill in the exact steps and links themselves (pass taskIds; why = what failed).",
    parametersSchema: schema(["sprintId"], {
      sprintId,
      kind: choice(["grant", "review", "pr", "message", "task", "indexing"], "Item type (default grant): grant, review, pr (PR to merge), message (text to send), task or indexing"),
      key: text("Stable key for dedupe, e.g. pr:<url>; or a standard key: github_token, site_project, service_account, bing_key, wp_connector, wp_sftp"),
      title: text("Short title (max 200 chars); required unless a standard key"),
      why: text("Why it is needed (max 2000 chars); required unless a standard key (github_token: what failed)"),
      steps: list("Exact steps"),
      links: list('"Label | https://…" or a bare URL'),
      copy: text("Copy-ready text (DM, email, post)"),
      after: text("What you do once it is done (required unless a standard key)"),
      taskIds: list("Tasks that continue when it is done"),
      optional: flag("Listed under Optional on the Needs you issue (default false)"),
      wpVerifyFailed: text("Verification items on a WordPress site with wp-verify are refused unless this says what you tried and the error; it is recorded on the sprint."),
    }),
  },
  { group: "Needs you", name: "needs-you-resolve", displayName: "Resolve Needs you item", description: "Mark an item done (when the person confirmed it). Checkable items (keys, access, repo link) are re-checked first; waiting tasks go back to you.", parametersSchema: schema(["sprintId", "key"], { sprintId, key: text("Item key (from needs-you)"), note: text("What was done, stored on the item (max 1000 chars)") }) },
  { group: "Needs you", name: "setup-checklist", displayName: "Setup checklist", description: "Every one-time setup item (settings, service account, GitHub access, agent, keys; per sprint: site repo or WordPress Connector, property, Bing, autopilot) with status, links and what you do next.", parametersSchema: schema([], { sprintId }) },

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

  // AI search (GEO)
  {
    group: "AI search (GEO)",
    name: "geo-audit",
    displayName: "AI-search readiness audit",
    description:
      "Only on a sprint a person switched AI search on for (get-switches); with a sprintId on any other sprint it refuses, reads nothing and changes nothing. Check whether AI answer engines can read and quote the site: which AI crawlers robots.txt allows (search, user and training bots; training is the client's choice and not scored), whether the server refuses them, llms.txt, Organization data and sameAs links, answer blocks and FAQ coverage, snippet limits, and name and phone consistency across profiles and directory listings. Returns a 0-100 readiness score with its sections, findings and next steps. With sprintId it records the audit and its findings (a re-run closes what it no longer reports, but never what it could not check this time) and keeps the firewall item on Needs you in step; a server refusal counts only when a second request repeats it next to an ordinary one. With only a url (any site) nothing is recorded and no bot user agent is sent. Readiness is not how often AI assistants mention the business: sample that with record-ai-mentions.",
    parametersSchema: schema([], {
      sprintId: text("Sprint id: audits the sprint's site and records the result"),
      url: text("A page on the sprint's site; or, without sprintId, any site's address (nothing is recorded then)"),
      pages: list("Pages to sample for answer blocks (up to 8); default: the home page, the sprint's own pages and the sitemap's main pages"),
      brand: text("Without sprintId: the business name to look for on profile pages"),
      dryRun: flag("true = run the checks and record nothing (default false)"),
    }),
  },
  {
    group: "AI search (GEO)",
    name: "record-ai-mentions",
    displayName: "Record sampled AI answers",
    description:
      "Only on a sprint a person switched AI search on for (get-switches); otherwise it refuses. Record what you saw when you asked an AI assistant or a search tool the questions customers ask: whether the answer named the business or listed one of its pages as a source, with the evidence, and which competitors it named. Only record answers you really obtained with a tool of yours; never fill a gap with what an assistant would probably say. A mention or citation without a short quote or source URLs (one on the site for a citation) is refused. The same question on the same assistant on the same day replaces that day's row.",
    parametersSchema: schema(["sprintId", "samples"], {
      sprintId,
      samples: {
        type: "array",
        description: "The sampled answers, at most 40 per call",
        items: {
          type: "object",
          required: ["query", "engine", "mentioned"],
          properties: {
            query: text("The question you asked, as a customer would (at most 200 characters)"),
            engine: choice(AI_ENGINES, "Which assistant or tool gave the answer; search_tool = your own web search tool"),
            mentioned: flag("The answer names the business"),
            cited: flag("The answer lists a page of the site as a source (needs citedUrls on the site)"),
            citedUrls: list("The source URLs the answer listed (at most 10)"),
            evidence: text("A short quote from the answer that shows the mention (at most 400 characters)"),
            position: int("Where the business sits when the answer lists several (1 = first)"),
            competitors: list("Businesses the answer named instead or as well (at most 10)"),
            sampledOn: text("The day you asked, YYYY-MM-DD (default today)"),
            method: text("How you got the answer, e.g. 'Claude web search tool' (at most 120 characters)"),
            note: text("Anything worth keeping about this answer (at most 400 characters)"),
          },
        },
      },
    }),
  },
  {
    group: "AI search (GEO)",
    name: "list-ai-mentions",
    displayName: "List sampled AI answers",
    description:
      "Needs AI search switched on for the sprint (get-switches); otherwise it says it is off. The AI answers sampled for the sprint: the rate at which the business was named or cited (the latest answer per question and assistant), the trend from the first sampling day to the latest, the competitors named instead, and suggested questions to ask when fewer than 10 are sampled. A handful of samples is a signal, not a measurement.",
    parametersSchema: schema(["sprintId"], { sprintId, limit: int("Questions to return (default 30, at most 100)") }),
  },

  // Google Analytics
  {
    group: "Google Analytics",
    name: "connect-ga4",
    displayName: "Connect Google Analytics (GA4)",
    description:
      "Only on a sprint a person switched Google Analytics on for (get-switches); otherwise it refuses, calls Google not at all and changes nothing. Connect the sprint to its Google Analytics 4 property (read only, through the same Google service account as Search Console) and pull the last 13 weeks. Without propertyId it finds the property by the site's address once the property's owner has added the service account as a Viewer. A propertyId must be this site's (one of its web streams has the site's address): the service account can read other clients' properties, so an id that is not this site's is refused, and you never try ids you were not given by this site's owner. When a one-time grant is missing (the Google Analytics APIs enabled for the project, or the Viewer access) it goes on the sprint's Needs you digest with the exact steps and, for a client, the email to send; the plugin retries every morning, so carry on with other work.",
    parametersSchema: schema(["sprintId"], {
      sprintId,
      propertyId: text("GA4 property ID (a number, Admin → Property settings). Must be this site's, from its owner, never guessed. Omit it to find the property by the site's address"),
    }),
  },
  {
    group: "Google Analytics",
    name: "list-ga4-summary",
    displayName: "GA4 organic traffic and key events",
    description:
      "Needs Google Analytics switched on for the sprint (get-switches); otherwise it says it is off. Weekly sessions, engaged sessions and key events from GA4, the Organic Search channel, and how much organic traffic and how many key events landed on the pages this sprint made or targets (live content, keyword targets, approved optimizations) against every other page. Also AI-assistant referrals, key events by name and top sources. Use it in the weekly review and the day-90 report; never quote a number it did not return.",
    parametersSchema: schema(["sprintId"], { sprintId, weeks: int("Weeks to return (default 8, at most 26)") }),
  },

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
