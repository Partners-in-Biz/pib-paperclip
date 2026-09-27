/**
 * Outrank 90-day SEO sprint template (ported from the old platform's
 * `lib/seo/templates/outrank-90.ts`, version 1 → 2).
 *
 * Every task keeps the old week, phase, focus, title, taskType, autopilot flag
 * and legacy tool anchor. Version 2 adds a stable `templateKey` (seeding is
 * idempotent on it), an `owner` (who does the work) and a playbook key (the
 * skill's `references/outrank-90.md` section and the issue description).
 *
 * Version 4 (plugin 0.8.0): the Social agent owns repurposing. Tasks w5/w6
 * no longer draft social posts; they make sure the post is marked live (which
 * hands it to Social once it answers 200) and link the Social drafts to the
 * content row. `TEMPLATE_V4_CHANGES` lists what the upgrade rewrites.
 *
 * Version 3 (plugin 0.6.0) removes every person task: the agent verifies
 * Search Console with the service account, gets pages crawled through the
 * sitemap / IndexNow / URL Inspection APIs, sets up Bing through its API,
 * decides cross-links, and drafts link-trade DMs and community posts. What a
 * person still has to do (one-time grants, messages from personal accounts)
 * goes on the weekly Needs you digest. `TEMPLATE_V3_CHANGES` lists what the
 * upgrade rewrites on existing sprints.
 *
 * Tasks with `autopilotEligible: false` are review-gated in `safe` mode: the
 * agent prepares the work and hands it over with `block-task` + `review: true`
 * (publishing posts, pSEO launches, pitches, public announcements).
 *
 * This is the software (SaaS) plan. `plans.ts` builds the local service,
 * professional services and online shop plans from these tasks plus their own
 * (the plan a sprint follows is its `template_id`). Titles are plain words
 * (no GSC, DR or LCP): people read them on the SEO page.
 */

export const TEMPLATE_ID = "outrank-90";
export const TEMPLATE_VERSION = 4;
export const TEMPLATE_NAME = "Outrank 90-Day SEO Sprint";

export type TaskOwner = "agent" | "human";
export type SprintPhase = 0 | 1 | 2 | 3 | 4;

export interface SeoTaskTemplate {
  templateKey: string;
  week: number;
  phase: 0 | 1 | 2 | 3;
  focus: string;
  title: string;
  taskType: string;
  owner: TaskOwner;
  autopilotEligible: boolean;
  /** Playbook key in `PLAYBOOKS` (the template key for template tasks). */
  playbook: string;
  /** Sprint day the task becomes due when it is not the start of its week. */
  dueDay?: number;
  /** Anchor of the old admin tool, kept for traceability only. */
  internalToolPath?: string;
}

export interface SeoTemplate {
  id: string;
  version: number;
  name: string;
  tasks: SeoTaskTemplate[];
}

function task(input: Omit<SeoTaskTemplate, "playbook"> & { playbook?: string }): SeoTaskTemplate {
  return { ...input, playbook: input.playbook ?? input.templateKey };
}

export const OUTRANK_90: SeoTemplate = {
  id: TEMPLATE_ID,
  version: TEMPLATE_VERSION,
  name: TEMPLATE_NAME,
  tasks: [
    // Phase 0 — Pre-launch (Week 0)
    task({ templateKey: "w0-meta-tags", week: 0, phase: 0, focus: "Pre-launch", title: "Set up the title, description and share image on every page", taskType: "meta-tag-audit", owner: "agent", autopilotEligible: true, internalToolPath: "/admin/seo/tools#metadata-check" }),
    task({ templateKey: "w0-schema", week: 0, phase: 0, focus: "Pre-launch", title: "Add SoftwareApplication + FAQ schema (structured data)", taskType: "schema-add", owner: "agent", autopilotEligible: true }),
    task({ templateKey: "w0-gsc-verify", week: 0, phase: 0, focus: "Pre-launch", title: "Verify the site in Google Search Console (service account)", taskType: "gsc-verify", owner: "agent", autopilotEligible: true }),
    task({ templateKey: "w0-sitemap-submit", week: 0, phase: 0, focus: "Pre-launch", title: "Submit the sitemap to Google Search Console", taskType: "sitemap-submit", owner: "agent", autopilotEligible: true, internalToolPath: "/admin/seo/tools#sitemap-check" }),
    task({ templateKey: "w0-gsc-request-index", week: 0, phase: 0, focus: "Pre-launch", title: "Get Google and Bing to crawl the 5 core pages", taskType: "gsc-request-index", owner: "agent", autopilotEligible: true }),
    task({ templateKey: "w0-bing-verify", week: 0, phase: 0, focus: "Pre-launch", title: "Set up Bing Webmaster Tools (add, verify, submit the sitemap)", taskType: "bing-verify", owner: "agent", autopilotEligible: true }),
    task({ templateKey: "w0-cross-link", week: 0, phase: 0, focus: "Pre-launch", title: "Link to the site from another site we own (or skip)", taskType: "cross-link", owner: "agent", autopilotEligible: true }),
    // Phase 1 — Foundation (Weeks 1-4)
    task({ templateKey: "w1-robots-check", week: 1, phase: 1, focus: "Tech Audit", title: "Check robots.txt: nothing blocks search engines", taskType: "robots-check", owner: "agent", autopilotEligible: true, internalToolPath: "/admin/seo/tools#robots-check" }),
    task({ templateKey: "w1-gsc-index-check", week: 1, phase: 1, focus: "Tech Audit", title: "Check Google has indexed every core page", taskType: "gsc-index-check", owner: "agent", autopilotEligible: true }),
    task({ templateKey: "w1-pagespeed-check", week: 1, phase: 1, focus: "Tech Audit", title: "Check page speed with PageSpeed Insights", taskType: "pagespeed-check", owner: "agent", autopilotEligible: true }),
    task({ templateKey: "w1-cwv-check", week: 1, phase: 1, focus: "Tech Audit", title: "Check Core Web Vitals: loads in under 2.5 s, no layout jumps", taskType: "cwv-check", owner: "agent", autopilotEligible: true }),
    task({ templateKey: "w1-canonical-check", week: 1, phase: 1, focus: "Tech Audit", title: "Check the canonical tag on every key page", taskType: "canonical-check", owner: "agent", autopilotEligible: true, internalToolPath: "/admin/seo/tools#canonical-check" }),
    task({ templateKey: "w1-alt-text", week: 1, phase: 1, focus: "Tech Audit", title: "Describe every image (alt text)", taskType: "alt-text-audit", owner: "agent", autopilotEligible: true }),
    task({ templateKey: "w1-noindex", week: 1, phase: 1, focus: "Tech Audit", title: "Keep login, dashboard and onboarding pages out of Google (noindex)", taskType: "noindex-add", owner: "agent", autopilotEligible: true }),
    task({ templateKey: "w2-keyword-discover", week: 2, phase: 1, focus: "Keywords", title: "Pick 20–30 winnable keywords (top results with a domain rating under 50)", taskType: "keyword-discover", owner: "agent", autopilotEligible: true, internalToolPath: "/admin/seo/tools#keyword-discover" }),
    task({ templateKey: "w2-keyword-bucket", week: 2, phase: 1, focus: "Keywords", title: "Sort the keywords by intent: problem, solution or brand", taskType: "keyword-bucket", owner: "agent", autopilotEligible: true }),
    task({ templateKey: "w2-keyword-prioritize", week: 2, phase: 1, focus: "Keywords", title: "Pick the 5 keywords to write for first", taskType: "keyword-prioritize", owner: "agent", autopilotEligible: true }),
    task({ templateKey: "w2-keyword-record", week: 2, phase: 1, focus: "Keywords", title: "Record all keywords in the Keywords tab", taskType: "keyword-record", owner: "agent", autopilotEligible: true }),
    task({ templateKey: "w3-homepage", week: 3, phase: 1, focus: "Core Pages", title: "Write the home page around the main keyword", taskType: "page-write", owner: "agent", autopilotEligible: true, internalToolPath: "/admin/seo/tools#title-generate" }),
    task({ templateKey: "w3-use-case-page", week: 3, phase: 1, focus: "Core Pages", title: "Write the main use-case page", taskType: "page-write", owner: "agent", autopilotEligible: true }),
    task({ templateKey: "w3-comparison-page", week: 3, phase: 1, focus: "Core Pages", title: "Write the first comparison page (you vs the category leader)", taskType: "page-write", owner: "agent", autopilotEligible: true }),
    task({ templateKey: "w4-faq-schema", week: 4, phase: 1, focus: "Core Pages", title: "Add FAQ schema to all three core pages", taskType: "schema-add", owner: "agent", autopilotEligible: true }),
    task({ templateKey: "w4-internal-links", week: 4, phase: 1, focus: "Core Pages", title: "Link the core pages to each other", taskType: "internal-link-add", owner: "agent", autopilotEligible: true }),
    // Phase 2 — Content engine (Weeks 5-10)
    task({ templateKey: "w5-post-1", week: 5, phase: 2, focus: "Content", title: "Publish post 1: a comparison or alternatives post", taskType: "post-publish", owner: "agent", autopilotEligible: false }),
    task({ templateKey: "w5-repurpose-1", week: 5, phase: 2, focus: "Content", title: "Hand post 1 to Social: mark it live, then link its social posts", taskType: "post-repurpose", owner: "agent", autopilotEligible: true }),
    task({ templateKey: "w6-post-2", week: 6, phase: 2, focus: "Content", title: "Publish post 2: a use-case post", taskType: "post-publish", owner: "agent", autopilotEligible: false }),
    task({ templateKey: "w6-repurpose-2", week: 6, phase: 2, focus: "Content", title: "Hand post 2 to Social: mark it live, then link its social posts", taskType: "post-repurpose", owner: "agent", autopilotEligible: true }),
    task({ templateKey: "w7-pillar", week: 7, phase: 2, focus: "Pillar Post", title: "Publish the pillar post (2,000+ words on the core topic)", taskType: "pillar-publish", owner: "agent", autopilotEligible: false }),
    task({ templateKey: "w7-pillar-links", week: 7, phase: 2, focus: "Pillar Post", title: "Link every existing post to the pillar", taskType: "internal-link-add", owner: "agent", autopilotEligible: true }),
    task({ templateKey: "w8-pseo-feature", week: 8, phase: 2, focus: "pSEO", title: "Launch a page for each feature (one template)", taskType: "pseo-feature", owner: "agent", autopilotEligible: false }),
    task({ templateKey: "w8-pseo-comparison", week: 8, phase: 2, focus: "pSEO", title: "Launch alternative and comparison pages (one template)", taskType: "pseo-comparison", owner: "agent", autopilotEligible: false }),
    // The old executor only flipped statuses. complete-task now refuses this task while any directory is still not started.
    task({ templateKey: "w9-directories", week: 9, phase: 2, focus: "Backlinks", title: "Submit to the 15 SaaS directories (log each in Backlinks)", taskType: "directory-submission", owner: "agent", autopilotEligible: true }),
    task({ templateKey: "w9-link-trade-dm", week: 9, phase: 2, focus: "Backlinks", title: "Find 3 link-swap partners and draft the messages", taskType: "link-trade-dm", owner: "agent", autopilotEligible: false }),
    task({ templateKey: "w10-guest-post", week: 10, phase: 2, focus: "Backlinks", title: "Pitch a guest post to a relevant blog (domain rating 40+)", taskType: "guest-post-pitch", owner: "agent", autopilotEligible: false }),
    task({ templateKey: "w10-community", week: 10, phase: 2, focus: "Backlinks", title: "Share on IndieHackers and relevant subreddits (Reddit through Social)", taskType: "community-post", owner: "agent", autopilotEligible: false }),
    // Phase 3 — Authority (Weeks 11-13)
    task({ templateKey: "w11-stuck-pages", week: 11, phase: 3, focus: "Authority", title: "Find pages ranking 8–20 in Google Search Console", taskType: "gsc-stuck-pages", owner: "agent", autopilotEligible: true }),
    task({ templateKey: "w11-update-stuck", week: 11, phase: 3, focus: "Authority", title: "Improve each page ranking 8–20 (depth, FAQ, structure)", taskType: "page-rewrite", owner: "agent", autopilotEligible: true }),
    task({ templateKey: "w12-cluster-pick", week: 12, phase: 3, focus: "Cluster", title: "Pick one keyword theme for a content cluster", taskType: "cluster-pick", owner: "agent", autopilotEligible: true }),
    task({ templateKey: "w12-cluster-publish", week: 12, phase: 3, focus: "Cluster", title: "Publish 5–7 supporting posts around the pillar, all linked", taskType: "cluster-publish", owner: "agent", autopilotEligible: false }),
    task({ templateKey: "w13-audit-metrics", week: 13, phase: 3, focus: "Day 90 Audit", title: "Pull the day-90 numbers: impressions, clicks, links, keywords", taskType: "audit-snapshot", owner: "agent", autopilotEligible: true, dueDay: 90 }),
    task({ templateKey: "w13-audit-report", week: 13, phase: 3, focus: "Day 90 Audit", title: "Write the day-90 report", taskType: "audit-render", owner: "agent", autopilotEligible: true, dueDay: 90 }),
    task({ templateKey: "w13-audit-announce", week: 13, phase: 3, focus: "Day 90 Audit", title: "Share the day-90 results on LinkedIn and X (with the client's OK)", taskType: "audit-announce", owner: "agent", autopilotEligible: false, dueDay: 90 }),
  ],
};

export interface DirectorySeed {
  source: string;
  domain: string;
  /** Domain rating from a real source; null when we do not know it (never guessed). */
  dr: number | null;
  /** Backlink type: directory (a listing site) or citation (a business profile such as Google Business Profile). Default directory. */
  type?: "directory" | "citation";
}

/** The 15 SaaS directories the old platform seeded into every sprint (DR from the old list). The software plan's sources. */
export const DEFAULT_DIRECTORIES: DirectorySeed[] = [
  { source: "producthunt.com", domain: "producthunt.com", dr: 80 },
  { source: "g2.com", domain: "g2.com", dr: 90 },
  { source: "capterra.com", domain: "capterra.com", dr: 88 },
  { source: "crunchbase.com", domain: "crunchbase.com", dr: 91 },
  { source: "saashub.com", domain: "saashub.com", dr: 62 },
  { source: "alternativeto.net", domain: "alternativeto.net", dr: 75 },
  { source: "betalist.com", domain: "betalist.com", dr: 58 },
  { source: "stackshare.io", domain: "stackshare.io", dr: 66 },
  { source: "theresanaiforthat.com", domain: "theresanaiforthat.com", dr: 55 },
  { source: "futurepedia.io", domain: "futurepedia.io", dr: 52 },
  { source: "topai.tools", domain: "topai.tools", dr: 44 },
  { source: "startupbase.io", domain: "startupbase.io", dr: 40 },
  { source: "microlaunch.net", domain: "microlaunch.net", dr: 38 },
  { source: "launched.io", domain: "launched.io", dr: 35 },
  { source: "indiehackers.com", domain: "indiehackers.com", dr: 72 },
];

export const PHASE_NAMES: Record<SprintPhase, string> = {
  0: "Pre-launch",
  1: "Foundation",
  2: "Content engine",
  3: "Authority",
  4: "Compounding",
};

/** Phase comes from the template week, never from the day count. */
export function phaseForWeek(week: number): SprintPhase {
  if (week <= 0) return 0;
  if (week <= 4) return 1;
  if (week <= 10) return 2;
  if (week <= 13) return 3;
  return 4;
}

/** Sprint day a template task becomes due. `null` means due immediately (pre-launch work). */
export function dueDayFor(week: number, dueDay?: number | null): number | null {
  if (typeof dueDay === "number") return dueDay;
  if (week <= 0) return null;
  return (week - 1) * 7 + 1;
}

/** Template keys whose owner, title or sign-off flag changed in version 3 (rewritten on existing sprints). */
export const TEMPLATE_V3_CHANGES = [
  "w0-gsc-verify",
  "w0-gsc-request-index",
  "w0-bing-verify",
  "w0-cross-link",
  "w1-alt-text",
  "w1-noindex",
  "w9-link-trade-dm",
  "w10-community",
] as const;

/** Template keys changed in version 4: repurposing moved to the Social agent (rewritten on existing sprints). */
export const TEMPLATE_V4_CHANGES = ["w5-repurpose-1", "w6-repurpose-2"] as const;

export function templateTask(templateKey: string): SeoTaskTemplate | undefined {
  return OUTRANK_90.tasks.find((t) => t.templateKey === templateKey);
}
