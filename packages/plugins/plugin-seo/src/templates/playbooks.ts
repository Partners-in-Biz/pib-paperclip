/**
 * Playbooks for every Outrank-90 task and for the task types the optimization
 * loop generates. They feed two places:
 * - the Paperclip issue description of each materialised task, and
 * - the skill file `references/outrank-90.md`.
 *
 * Tool names without a colon are SEO plugin tools (`partnersinbiz.seo:<name>`).
 * Names with a colon are other plugins' tools, used only when the agent holds them.
 */

export interface Playbook {
  goal: string;
  steps: string[];
  tools: string[];
  done: string;
  evidence: string;
}

const SITE_CHANGE =
  "Make the change through the site repo (the issue's Site repo section; skill `references/site-changes.md`): branch `seo/<task>`, commit, push, open a PR, wait for CI and the preview, verify on the preview with the check tools, `check-change-scope`, then merge when it says merge (or add the PR to Needs you). No repo link (site access none): write the exact change set and add it to Needs you with `needs-you-add`.";

const AFTER_DEPLOY = "After the deploy, re-run the same checks on production and `complete-task` with the PR link, the commit and the check output.";

export const PLAYBOOKS: Record<string, Playbook> = {
  "w0-meta-tags": {
    goal: "Every indexable page has a unique title (50–60 chars), meta description (70–160 chars), canonical, og:title and og:image.",
    steps: [
      "Run `check-sitemap` (with sprintId) to list the site's URLs; pick the home page and up to 10 core pages.",
      "Run `check-meta` on each page with sprintId so issues are recorded as findings.",
      "Write the missing or weak titles/descriptions around each page's target keyword (use `list-keywords` if keywords exist yet).",
      SITE_CHANGE,
      "Re-run `check-meta` on production after the deploy; the resolved findings close automatically.",
    ],
    tools: ["check-sitemap", "check-meta", "list-keywords", "audit-summary"],
    done: "`check-meta` reports no missing title, description, og:image or canonical on the home page and core pages.",
    evidence: "Pages checked, the before/after titles and descriptions, and the PR/commit or the handoff issue.",
  },
  "w0-schema": {
    goal: "Home page carries valid Organization/WebSite JSON-LD plus the schema type that fits the business (SoftwareApplication for software, LocalBusiness/ProfessionalService for service firms) and an FAQPage block where the page has FAQs.",
    steps: [
      "Run `validate-schema` on the home page (with sprintId) to see what exists.",
      "Choose the right types for this client (do not add SoftwareApplication to a law firm or guest house).",
      "Draft the JSON-LD with real facts only (name, url, logo, contact, address, opening hours, FAQs that appear on the page).",
      SITE_CHANGE,
      "Re-run `validate-schema` and confirm the types parse with no missing required properties.",
    ],
    tools: ["validate-schema", "get-sprint"],
    done: "`validate-schema` finds the chosen types on the home page with no parse errors or missing required properties.",
    evidence: "The JSON-LD you added (or its PR), and the validate-schema result.",
  },
  "w0-gsc-verify": {
    goal: "The service account is a verified owner of the site, the Search Console property is added to this sprint, and the sitemap is submitted.",
    steps: [
      "Run `gsc-check-access`. If the service account already sees the property, it is selected: go to the last step.",
      "Own site with a repo: `gsc-verification-token` (method META for a URL-prefix property). It returns the exact meta tag (Next.js: `metadata.verification.google`).",
      "Add the tag to the root layout's <head> through the repo — a verification file is SEO scope, so merge it yourself when checks pass. " + AFTER_DEPLOY.replace("`complete-task` with", "note"),
      "Run `gsc-verify-site`: Google verifies the tag, the service account becomes an owner, the property is added and stored, and the sitemap is submitted.",
      "Client site without repo access: `gsc-check-access` puts the ready-to-send email (service account email + Search Console Users link) on the Needs you digest. Block this task with `block-task`; it comes back when the plugin sees access.",
      "No service account key yet: the tools put it on Needs you. Block with `block-task` and move on to other work.",
    ],
    tools: ["gsc-check-access", "gsc-verification-token", "gsc-verify-site", "check-meta", "check-change-scope", "gsc-pull"],
    done: "`gsc-verify-site` (or `gsc-check-access`) reports the property connected via the service account, and `gsc-pull` succeeds.",
    evidence: "Property URL, verification method, the PR/commit that added the tag, and the sitemap submission.",
  },
  "w0-sitemap-submit": {
    goal: "sitemap.xml is valid and submitted to the verified GSC property.",
    steps: [
      "Run `check-sitemap` (with sprintId). A missing or broken sitemap is a code fix: `add-task` a code task (it opens in the site project) or fix it in this run if you are in the repo workspace.",
      "If Search Console is not set up yet, do the `w0-gsc-verify` task first (it submits the sitemap too) — never ask a person to click Connect.",
      "Run `gsc-submit-sitemap` (defaults to <site>/sitemap.xml, or pass the sitemap URL robots.txt declares).",
    ],
    tools: ["check-sitemap", "check-robots", "gsc-submit-sitemap", "gsc-check-access"],
    done: "`gsc-submit-sitemap` returns submitted for a sitemap that `check-sitemap` parses with URLs.",
    evidence: "Sitemap URL, URL count, and the submission result.",
  },
  "w0-gsc-request-index": {
    goal: "The 5 most important pages are discovered and crawled: sitemap submitted, IndexNow pinged, and URL Inspection confirms their state.",
    steps: [
      "Google has no public API to 'Request indexing' for normal pages (the Indexing API is only for job postings and livestreams). Do not ask a person to click it.",
      "Run `indexnow-key`. If the key file is not live, add it through the repo (`public/<key>.txt`; SEO scope), merge when checks pass, and wait for the deploy.",
      "Run `request-indexing` (optionally with the 5 core URLs): it submits the sitemap to Search Console, pings IndexNow (Bing and others) and inspects each URL.",
      "Fix what the inspections show (noindex, canonical elsewhere, blocked, 4xx/5xx) as code tasks. Make sure every core page is linked from the home page.",
      "Complete the task with the inspection table. The daily run re-inspects the pages after 14 days and only then adds optional URL-inspection links to Needs you for any still not indexed.",
    ],
    tools: ["indexnow-key", "request-indexing", "gsc-inspect-url", "crawler-sim", "check-change-scope"],
    done: "Sitemap submitted, IndexNow accepted (200/202), and each core URL inspected with its state recorded.",
    evidence: "The URLs with their coverage state, the IndexNow status, and the sitemap submission.",
  },
  "w0-bing-verify": {
    goal: "The site is added and verified in Bing Webmaster Tools through the API, with the sitemap submitted.",
    steps: [
      "Run `bing-add-site`. Without a Bing API key it puts the key on Needs you: block this task with `block-task` and carry on elsewhere.",
      "Add the returned BingSiteAuth.xml (`public/BingSiteAuth.xml`) or the msvalidate.01 meta tag through the repo (SEO scope), merge when checks pass, wait for the deploy.",
      "Run `bing-verify-site`: it verifies, enables Bing on the sprint and submits the sitemap.",
      "(Import from Google Search Console is not available in the Bing API; the XML file is the API route.)",
    ],
    tools: ["bing-add-site", "bing-verify-site", "bing-submit", "check-change-scope"],
    done: "`bing-verify-site` reports verified and the sitemap submitted.",
    evidence: "Verified site URL, the PR that added BingSiteAuth.xml, the sitemap submission.",
  },
  "w0-cross-link": {
    goal: "A trusted property we control links to the new site so search engines discover it quickly — or the task is skipped with a reason.",
    steps: [
      "`list-sprints` and `list-site-projects`: is there another site of ours (another sprint or a linked project with a repo) that is relevant to this one?",
      "Yes: add a followed, contextual link (footer, about page or a relevant post) in that site's repo — internal/cross links are SEO scope. Record it with `add-backlink` (type organic, status live, url of the linking page) after the deploy.",
      "No sibling property (an established site, or a client with no other property of ours): `skip-task` with the reason. Do not hand this to a person.",
    ],
    tools: ["list-sprints", "list-site-projects", "add-backlink", "check-change-scope", "skip-task"],
    done: "A live link from a property we own is recorded, or the task is skipped with the reason.",
    evidence: "The linking page URL and PR, or the skip reason.",
  },
  "w1-robots-check": {
    goal: "robots.txt exists, allows crawling of public pages and declares the sitemap.",
    steps: [
      "Run `check-robots` with sprintId.",
      "Any `Disallow: /` for * or Googlebot, or blocked core paths, is a critical fix. Missing Sitemap: line is a minor fix.",
      SITE_CHANGE,
      "Re-run `check-robots` to confirm.",
    ],
    tools: ["check-robots", "crawler-sim"],
    done: "`check-robots` reports no blocking rules for public pages and lists at least one sitemap.",
    evidence: "robots.txt status and rules summary, plus any fix made.",
  },
  "w1-gsc-index-check": {
    goal: "Every core page is indexed in Google.",
    steps: [
      "Needs Search Console access: if `gsc-inspect-url` says it is not set up, do the verify task (`w0-gsc-verify`) first.",
      "Run `gsc-inspect-url` for the home page and each core page (5–10 URLs).",
      "For pages not indexed, run `crawler-sim` to find the cause (noindex, canonical elsewhere, blocked, 4xx/5xx, thin JS-only content) and record findings.",
      "Fix the causes as code changes; then `request-indexing` for those URLs (sitemap + IndexNow + inspection).",
    ],
    tools: ["gsc-inspect-url", "crawler-sim", "record-finding", "request-indexing"],
    done: "Each core page is inspected and either indexed or has a recorded cause and a fix in progress.",
    evidence: "Table of URL → coverage state → action.",
  },
  "w1-pagespeed-check": {
    goal: "Know the mobile performance, SEO, accessibility and best-practice scores of the home page and core pages.",
    steps: [
      "Run `run-pagespeed` (mobile) with sprintId for the home page and 2–3 core pages (one per call; each takes up to 25 s).",
      "Record anything under 50 performance or 90 SEO as a finding with the main opportunity (the tool records CWV failures automatically).",
    ],
    tools: ["run-pagespeed", "record-finding"],
    done: "PageSpeed results are stored for the home page and at least two core pages.",
    evidence: "Scores per URL and the top 3 opportunities.",
  },
  "w1-cwv-check": {
    goal: "Core Web Vitals pass: LCP < 2.5 s, CLS < 0.1, INP < 200 ms (field data where Google has it).",
    steps: [
      "Use the page health from `get-sprint` (or run `run-pagespeed` first).",
      "For each failing metric, name the cause from the PageSpeed audit (hero image size, render-blocking CSS/JS, layout shift from images without size, heavy third-party scripts).",
      SITE_CHANGE,
    ],
    tools: ["run-pagespeed", "get-sprint", "record-finding"],
    done: "Every tracked page passes LCP and CLS, or each failure has a recorded cause and a fix in progress.",
    evidence: "LCP/CLS/INP per page before and after.",
  },
  "w1-canonical-check": {
    goal: "Each key page has one self-referencing canonical (or a deliberate canonical to the preferred URL).",
    steps: [
      "Run `check-canonical` with sprintId on the home page and core pages.",
      "Fix missing canonicals, canonicals to other pages by mistake, http vs https and trailing-slash mismatches.",
      SITE_CHANGE,
    ],
    tools: ["check-canonical", "check-sitemap"],
    done: "`check-canonical` reports a matching canonical on every key page.",
    evidence: "Pages checked and fixes made.",
  },
  "w1-alt-text": {
    goal: "Every meaningful image has descriptive alt text; decorative images have empty alt.",
    steps: [
      "Run `crawler-sim` on the home page and core pages; it reports images without alt text.",
      "Write alt text that describes the image in context (not keyword stuffing).",
      SITE_CHANGE,
      "Alt text is SEO scope: merge it yourself under merge_seo_scope when checks pass. " + AFTER_DEPLOY,
    ],
    tools: ["crawler-sim", "check-change-scope"],
    done: "`crawler-sim` reports no images missing alt text on the core pages.",
    evidence: "Count of images fixed per page and the PR or handoff.",
  },
  "w1-noindex": {
    goal: "Login, dashboard, onboarding, account and thank-you pages are noindexed and not in the sitemap.",
    steps: [
      "Find those URLs in the sitemap (`check-sitemap`) and via navigation.",
      "Run `crawler-sim` on each to see the current robots meta / X-Robots-Tag.",
      "Add `<meta name=\"robots\" content=\"noindex\">` (or the header) and remove them from the sitemap.",
      SITE_CHANGE,
    ],
    tools: ["check-sitemap", "crawler-sim"],
    done: "Every private/app page reports noindex in `crawler-sim` and is absent from the sitemap.",
    evidence: "List of URLs and their robots state.",
  },
  "w2-keyword-discover": {
    goal: "A long list of 20–30 winnable keywords: real searches, relevant to what the client sells, where the top results are not all DR 50+ giants.",
    steps: [
      "Collect 3–6 seed terms from the site, the client's services and the CRM notes.",
      "Run `discover-keywords` with the seeds (Google Autocomplete + seed variants). If GSC is connected, add queries from `gsc-query`.",
      "Judge winnability by looking at the current top results; record your DR estimate in difficultyDr when you have one. Never invent search volume: leave volume empty unless you have a real source.",
      "Save the shortlist with `add-keywords` (phrase, intent, optional difficultyDr, notes).",
    ],
    tools: ["discover-keywords", "gsc-query", "add-keywords", "list-keywords"],
    done: "At least 20 relevant keywords are tracked on the sprint.",
    evidence: "Count of keywords added and the seeds used.",
  },
  "w2-keyword-bucket": {
    goal: "Every tracked keyword has an intent: problem (researching the pain), solution (comparing options), brand (looking for the client).",
    steps: [
      "Run `list-keywords`.",
      "Set intent with `update-keyword` for each keyword that has none or a wrong guess.",
    ],
    tools: ["list-keywords", "update-keyword"],
    done: "No active keyword is missing an intent (complete-task checks this).",
    evidence: "Counts per bucket.",
  },
  "w2-keyword-prioritize": {
    goal: "Pick the 5 keywords to write for first, solution-aware first.",
    steps: [
      "Run `list-keywords`; prefer solution intent, clear buyer value and weak competition.",
      "Mark the 5 with `update-keyword` priority: true and set targetUrl if the page already exists.",
      "Create a content idea for each with `add-content` (type comparison / use-case / alternative).",
    ],
    tools: ["list-keywords", "update-keyword", "add-content"],
    done: "5 keywords are marked priority and each has a content row.",
    evidence: "The 5 keywords and their content ids.",
  },
  "w2-keyword-record": {
    goal: "All chosen keywords live in the sprint so GSC positions attach to them daily.",
    steps: [
      "Run `list-keywords` and add any missing ones with `add-keywords` (duplicates are ignored).",
      "Set targetUrl on keywords whose page exists so PageSpeed and the detectors can follow the page.",
    ],
    tools: ["list-keywords", "add-keywords", "update-keyword"],
    done: "At least 5 active keywords are tracked (complete-task checks this); the full list is recorded.",
    evidence: "Keyword count.",
  },
  "w3-homepage": {
    goal: "The home page targets the primary keyword: in the title, H1 and first paragraph, with a clear offer and internal links to core pages.",
    steps: [
      "Pick the primary keyword (`list-keywords`, priority first).",
      "Draft title, meta description, H1, intro and section structure; keep the client's voice and real facts.",
      SITE_CHANGE,
      "Run `check-meta` and `crawler-sim` on the live page.",
      "Record the page with `add-content` (type page, status live, targetUrl) or update the existing row.",
    ],
    tools: ["list-keywords", "check-meta", "crawler-sim", "add-content", "update-content"],
    done: "The live home page has the primary keyword in its title and H1 and passes `check-meta`.",
    evidence: "New title/H1, the URL, and the PR or handoff.",
  },
  "w3-use-case-page": {
    goal: "One page for the client's main use case or core service, built around a solution keyword.",
    steps: [
      "Choose the keyword (priority, solution intent).",
      "Outline: problem → how the client solves it → proof (cases, reviews) → FAQ → call to action.",
      "Write the page; link it from the home page.",
      SITE_CHANGE,
      "Record it with `add-content` (type use-case, targetKeywordId, targetUrl, status live when published) and set the keyword's targetUrl.",
    ],
    tools: ["list-keywords", "add-content", "update-content", "update-keyword", "check-meta"],
    done: "The page is live, passes `check-meta`, and is linked from the home page.",
    evidence: "URL, target keyword, PR or handoff.",
  },
  "w3-comparison-page": {
    goal: "A fair 'client vs category leader' (or 'alternatives to X') page for a solution keyword.",
    steps: [
      "Pick the competitor people actually compare against (autocomplete 'vs' results help).",
      "Write an honest comparison table, who each option is best for, pricing notes with dates, FAQ.",
      SITE_CHANGE,
      "Record it with `add-content` (type comparison) and set the keyword's targetUrl.",
    ],
    tools: ["discover-keywords", "add-content", "update-keyword", "check-meta"],
    done: "The comparison page is live and recorded as content.",
    evidence: "URL and the keyword it targets.",
  },
  "w4-faq-schema": {
    goal: "The three core pages (home, use-case, comparison) have FAQPage JSON-LD matching FAQs visible on the page.",
    steps: [
      "Run `validate-schema` on each page.",
      "Add FAQ content to the page if it has none, then the matching FAQPage JSON-LD.",
      SITE_CHANGE,
      "Re-run `validate-schema`.",
    ],
    tools: ["validate-schema"],
    done: "`validate-schema` finds a valid FAQPage on all three pages.",
    evidence: "Validation result per page.",
  },
  "w4-internal-links": {
    goal: "Core pages link to each other with descriptive anchors; no core page is an orphan.",
    steps: [
      "Run `internal-link-audit` with sprintId (bounded crawl of sitemap pages).",
      "Add contextual links: home → use-case and comparison; each → the other and back to home.",
      SITE_CHANGE,
      "Re-run the audit; set internalLinksAdded on the content rows with `update-content`.",
    ],
    tools: ["internal-link-audit", "update-content"],
    done: "No core page appears in the orphan list.",
    evidence: "Orphans before/after and links added.",
  },
  "w5-post-1": {
    goal: "Publish the first blog post in a comparison or alternative format for a priority keyword.",
    steps: [
      "Pick the next priority keyword without content (`list-keywords`, `list-content`).",
      "Write the post (1,200+ words, real facts, comparison table, FAQ, links to core pages).",
      "Create/update the content row: status drafting → review.",
      "Write it on a `seo/<task>` branch and open the PR; the Vercel preview is the draft. Safe mode: `block-task` with `review: true` and the preview link (the brief/draft needs sign-off). Once the owner approves (issue done or a comment), merge — a new post from an approved brief is SEO scope. Full mode: merge when checks pass.",
      "When live: `update-content` status live, targetUrl, publishOn.",
    ],
    tools: ["list-keywords", "list-content", "add-content", "update-content", "check-meta"],
    done: "The post is live and its content row is status live with its URL.",
    evidence: "Draft link, live URL, target keyword.",
  },
  "w5-repurpose-1": {
    goal: "Turn post 1 into a LinkedIn post and an X thread that link back to it.",
    steps: [
      "Read the live post (`list-content`).",
      "Draft both posts with the Social plugin (`partnersinbiz.social:create-post` then request review) if you hold those tools; the social approval step is the sign-off.",
      "Link each social post to the content row with `link-social-post`.",
      "Without social tools, write the copy and hand off with `block-task`.",
    ],
    tools: ["list-content", "link-social-post", "partnersinbiz.social:create-post"],
    done: "Two social drafts (LinkedIn + X) exist and are linked to the content row.",
    evidence: "Social post ids/links.",
  },
  "w6-post-2": {
    goal: "Publish the second post in a use-case format for a priority keyword.",
    steps: [
      "Same flow as post 1: pick keyword → write → content row → review handoff (safe) or publish (full) → mark live.",
      "Link to the pillar-to-be and core pages.",
    ],
    tools: ["list-keywords", "list-content", "add-content", "update-content", "check-meta"],
    done: "The post is live and recorded.",
    evidence: "Live URL and target keyword.",
  },
  "w6-repurpose-2": {
    goal: "Turn post 2 into a LinkedIn post and an X thread.",
    steps: [
      "Same as repurpose 1, for post 2.",
    ],
    tools: ["list-content", "link-social-post", "partnersinbiz.social:create-post"],
    done: "Two social drafts exist and are linked to the content row.",
    evidence: "Social post ids/links.",
  },
  "w7-pillar": {
    goal: "Publish a 2,000+ word pillar page covering the core topic end to end, linking out to every related post and core page.",
    steps: [
      "Choose the topic that the most tracked keywords roll up to.",
      "Outline sections that each could become a cluster post; write with real examples and data.",
      "Content row type pillar; review handoff in safe mode; publish when approved.",
      "Mark live with URL.",
    ],
    tools: ["list-keywords", "add-content", "update-content", "validate-schema"],
    done: "The pillar is live and recorded as content type pillar, status live.",
    evidence: "Live URL, word count, sections.",
  },
  "w7-pillar-links": {
    goal: "Every existing post links to the pillar (and the pillar links back).",
    steps: [
      "`list-content` to find the pillar id and all live posts.",
      "Add a contextual link to the pillar in each post.",
      SITE_CHANGE,
      "For each post that now links to the pillar: `update-content` with linksToPillarIds including the pillar id (the pillar_orphan detector counts these).",
    ],
    tools: ["list-content", "update-content", "internal-link-audit"],
    done: "At least 3 content rows list the pillar in linksToPillarIds.",
    evidence: "Posts updated.",
  },
  "w8-pseo-feature": {
    goal: "A repeatable page template for features/services (one page per feature or service line) with unique copy per page.",
    steps: [
      "List the features/services worth a page (from the site and CRM).",
      "Design the template: H1 pattern, sections, FAQ, schema, internal links.",
      "Write the first 3–5 pages; no thin duplicates.",
      "Safe mode: review handoff before launch.",
      "Record each as content (type feature).",
    ],
    tools: ["add-content", "check-meta", "validate-schema"],
    done: "At least 3 feature pages are live and recorded.",
    evidence: "URLs.",
  },
  "w8-pseo-comparison": {
    goal: "A template for 'alternative to X' / 'client vs X' pages, launched for the top competitors.",
    steps: [
      "Use autocomplete (`discover-keywords` with competitor names) to find real comparison searches.",
      "Build the template with an honest table and who-it-suits sections.",
      "Launch 3+ pages; review handoff in safe mode.",
      "Record each as content (type alternative or comparison) with its keyword.",
    ],
    tools: ["discover-keywords", "add-keywords", "add-content"],
    done: "At least 3 comparison/alternative pages are live and recorded.",
    evidence: "URLs and target keywords.",
  },
  "w9-directories": {
    goal: "Real directory listings: every seeded directory is submitted (with proof), live, or rejected as irrelevant — no status-only changes.",
    steps: [
      "`list-backlinks` type directory. The seed list is SaaS-focused: if the client is not a software product, mark irrelevant ones `rejected` with notes 'not relevant' and add relevant ones (Google Business Profile, industry bodies, local directories) with `add-backlink`.",
      "Prepare one listing kit: name, one-line and long description, category, logo URL, screenshots, pricing, contact, founding year. Put it in a comment on this issue.",
      "Directories need accounts, email verification and often CAPTCHAs: hand off with `block-task` listing the directories and the kit, unless the owner has told you in the sprint notes that you may submit.",
      "For each submission record `update-backlink` status submitted with notes (submission URL, date, account used). When a listing appears, status live with its URL.",
    ],
    tools: ["list-backlinks", "update-backlink", "add-backlink"],
    done: "No directory backlink is still not started (complete-task checks this).",
    evidence: "Per directory: submitted/live/rejected and the listing or submission URL.",
  },
  "w9-link-trade-dm": {
    goal: "Three complementary sites (not competitors) are asked for a relevant link swap, with the DMs written for the owner.",
    steps: [
      "Find 3–5 complementary businesses: our other sprints' sites, CRM contacts with sites, partners the client already works with, sites linking to competitors.",
      "Record each target with `add-backlink` (type link_trade, status not_started, notes with the person and profile link).",
      "Write one short personal DM per target (what we link to on their site, what we ask for, why it helps their readers).",
      "Messages the SEO Specialist cannot send itself (a founder's personal LinkedIn/X account) go on Needs you with `needs-you-add` (kind message, the DM in `copy`, the profile link in `links`). If an email channel exists for the sprint, send by email instead.",
      "Safe mode: `block-task` with `review: true` pointing to the Needs you item; when replies come in, record agreed links and mark them live when they appear.",
    ],
    tools: ["add-backlink", "update-backlink", "needs-you-add", "list-sprints"],
    done: "3 targets recorded with DMs drafted (sent by the owner from Needs you, or by email); agreed links recorded.",
    evidence: "Targets, the DM text, and outcomes.",
  },
  "w10-guest-post": {
    goal: "One guest-post pitch sent to a relevant blog with real authority (DR 40+ where you can check it).",
    steps: [
      "Find 3–5 relevant blogs that accept contributions; note their audience fit.",
      "Draft a pitch with 2–3 specific topic ideas that link naturally to the client's pillar or core pages.",
      "Safe mode: hand off with `block-task` and `review: true` so the owner sends it from their own email.",
      "Record the target with `add-backlink` (type guest_post, status in_progress, notes with contact and date).",
    ],
    tools: ["add-backlink", "update-backlink"],
    done: "The pitch is sent (by the owner or by you in full mode) and recorded.",
    evidence: "Blog, contact, pitch text, date sent.",
  },
  "w10-community": {
    goal: "Share the site where the audience already is (IndieHackers for founders, relevant subreddits/forums for others) with a useful post, not spam.",
    steps: [
      "Pick 1–3 communities whose rules allow it; read each one's self-promotion rules first.",
      "Draft a genuinely useful post (a lesson, data, a free resource) that links to the site.",
      "Reddit: if `partnersinbiz.social:list-connected-accounts` shows a Reddit account for this sprint's client (or PiB), create the post with `partnersinbiz.social:create-post` (overrides.reddit.subreddit) and `partnersinbiz.social:request-review` — the social approval is the sign-off.",
      "Communities without an API or account (IndieHackers, forums): add the ready post to Needs you (`needs-you-add` kind message, copy + link) for the owner to paste.",
      "Record each with `add-backlink` (type community) and mark live with the post URL once it is up.",
    ],
    tools: ["add-backlink", "needs-you-add", "partnersinbiz.social:list-connected-accounts", "partnersinbiz.social:create-post", "partnersinbiz.social:request-review"],
    done: "At least one community post is live (or approved in Social) and recorded.",
    evidence: "Post URLs or social post ids.",
  },
  "w11-stuck-pages": {
    goal: "List the pages/queries sitting at positions 8–20 — the ones a rewrite can push onto page one.",
    steps: [
      "Needs GSC: run `gsc-query` with positionMin 8, positionMax 20 (last 28 days).",
      "Group rows by page; rank by impressions.",
      "Track important queries as keywords (`add-keywords`) with targetUrl so the loop can measure them.",
      "Write the shortlist in the completion summary.",
    ],
    tools: ["gsc-query", "add-keywords", "list-keywords"],
    done: "A ranked list of stuck pages with their queries is recorded and the key queries are tracked.",
    evidence: "Top stuck pages with query, position, impressions.",
  },
  "w11-update-stuck": {
    goal: "Each stuck page gets deeper, better-structured content aimed at the queries it already ranks for.",
    steps: [
      "For each page from the stuck list: add sections that answer the ranking queries, an FAQ with FAQPage schema, better headings, internal links from strong pages.",
      "Update title/meta to match the dominant query when it differs.",
      SITE_CHANGE,
      "Record each update on the content row (`update-content` notes) and keep the keywords' targetUrl set.",
    ],
    tools: ["gsc-query", "check-meta", "validate-schema", "update-content"],
    done: "Every page on the stuck list is updated (or a reason is recorded).",
    evidence: "Pages updated and what changed.",
  },
  "w12-cluster-pick": {
    goal: "Choose one keyword theme around the pillar for a 5–7 post cluster.",
    steps: [
      "Look at keywords with impressions but weak positions (`list-keywords`, `gsc-query`).",
      "Pick the theme with the most related long-tail searches (`discover-keywords` on the theme).",
      "Add 5–7 content ideas with `add-content` (type cluster), each with its keyword.",
    ],
    tools: ["list-keywords", "gsc-query", "discover-keywords", "add-keywords", "add-content"],
    done: "5–7 cluster content ideas exist with target keywords.",
    evidence: "Theme and the cluster list.",
  },
  "w12-cluster-publish": {
    goal: "Publish the cluster posts, all linking to the pillar and to each other.",
    steps: [
      "Write each cluster post; link to the pillar and sibling posts.",
      "Safe mode: review handoff per batch.",
      "When live: `update-content` status live, targetUrl, linksToPillarIds with the pillar id.",
    ],
    tools: ["list-content", "update-content", "internal-link-audit"],
    done: "At least 5 cluster posts are live and each lists the pillar in linksToPillarIds.",
    evidence: "Live URLs.",
  },
  "w13-audit-metrics": {
    goal: "A Day 90 snapshot of traffic, rankings, authority and content.",
    steps: [
      "The daily job records the day-90 snapshot automatically on day 90. Run `gsc-pull` first if GSC is connected, then `run-audit-snapshot` (day 90) if it is missing or stale.",
      "Compare with the day 0/30/60 snapshots (`audit-summary`).",
    ],
    tools: ["gsc-pull", "run-audit-snapshot", "audit-summary"],
    done: "A snapshot for day 90 (or later) exists (complete-task checks this).",
    evidence: "Snapshot id and the headline numbers vs day 0.",
  },
  "w13-audit-report": {
    goal: "A short Day 90 report the client can read: what was done, what moved, what is next.",
    steps: [
      "Use `audit-summary` and the snapshots; list wins (keywords in top 10, impressions growth, links live) with real numbers only.",
      "Post the report as a comment on the sprint root issue (`post-digest`) and link the Audits tab.",
    ],
    tools: ["audit-summary", "post-digest"],
    done: "The report is posted on the sprint root issue.",
    evidence: "Link to the comment.",
  },
  "w13-audit-announce": {
    goal: "Share the 90-day results publicly (with the client's consent) on LinkedIn/X.",
    steps: [
      "Confirm the client agrees to share numbers (ask via `block-task` if unknown).",
      "Draft the post with the Social plugin (`partnersinbiz.social:create-post`) — the social approval step is the sign-off.",
      "Link it with `link-social-post` if a content row exists, or include the post link in the evidence.",
    ],
    tools: ["audit-summary", "partnersinbiz.social:create-post", "link-social-post"],
    done: "An approved (or awaiting approval) social post with the results exists.",
    evidence: "Social post link.",
  },

  // --- Optimization task types -------------------------------------------------
  "opt:page-rewrite": {
    goal: "Test the hypothesis on the target page: rewrite for depth, structure and intent match.",
    steps: [
      "Read the optimization evidence in this issue (keyword, positions, URL).",
      "Rewrite or extend the page as the hypothesis says; keep it factual.",
      SITE_CHANGE,
      "Do not change other variables on the page during the 14-day measurement window if you can avoid it.",
    ],
    tools: ["gsc-query", "check-meta", "validate-schema", "update-content"],
    done: "The change is live.",
    evidence: "What changed and when it went live.",
  },
  "opt:internal-link-add": {
    goal: "Add contextual internal links pointing to the target page from strong related pages.",
    steps: [
      "Run `internal-link-audit` to see inbound links; pick 3 relevant pages with traffic.",
      "Add links with descriptive anchors.",
      SITE_CHANGE,
      "Update linksToPillarIds on content rows when the target is a pillar.",
    ],
    tools: ["internal-link-audit", "update-content"],
    done: "At least 3 new internal links point to the target page.",
    evidence: "Source pages and anchors.",
  },
  "opt:index-diagnose": {
    goal: "Find out why the page gets no impressions or is not indexed.",
    steps: [
      "Run `gsc-inspect-url` and `crawler-sim` on the URL.",
      "Check robots, noindex, canonical, status code, sitemap inclusion and thin/JS-only content.",
      "Fix what you can; record the cause as a finding.",
    ],
    tools: ["gsc-inspect-url", "crawler-sim", "check-sitemap", "record-finding"],
    done: "The cause is recorded and fixed or handed off.",
    evidence: "Inspection state and crawler-sim result.",
  },
  "opt:gsc-request-index": {
    goal: "Get the fixed page recrawled.",
    steps: [
      "Run `request-indexing` with the URL: sitemap to Search Console, IndexNow ping, URL Inspection.",
      "Google has no public API to request indexing for normal pages; the daily run follows up after 14 days (optional Needs you links if it is still not indexed).",
    ],
    tools: ["request-indexing", "gsc-inspect-url"],
    done: "Sitemap and IndexNow submitted and the URL inspected.",
    evidence: "IndexNow status and the inspection state.",
  },
  "opt:directory-followup": {
    goal: "Resolve a directory submission that has been pending for 30+ days.",
    steps: [
      "Search the directory for the listing. If live, `update-backlink` status live with the URL.",
      "If not, follow up once (hand off if it needs the owner's account), or mark it `rejected`/`lost` with notes and add an alternative relevant directory with `add-backlink`.",
    ],
    tools: ["list-backlinks", "update-backlink", "add-backlink"],
    done: "The backlink is live, rejected/lost with a reason, or followed up with a date.",
    evidence: "Outcome and URL.",
  },
  "opt:cwv-audit": {
    goal: "Bring the page's Core Web Vitals back under LCP 2.5 s and CLS 0.1.",
    steps: [
      "Run `run-pagespeed` on the URL and read the top opportunities.",
      "Fix the biggest cause (image size/format, preload the LCP image, reserve space for images/embeds, defer third-party scripts).",
      SITE_CHANGE,
      "Re-run `run-pagespeed`.",
    ],
    tools: ["run-pagespeed"],
    done: "The page passes LCP and CLS, or the fix is with a developer.",
    evidence: "Before/after metrics.",
  },
  "opt:retarget": {
    goal: "Align the page's title, H1 and meta with the queries it actually gets impressions for, to lift CTR.",
    steps: [
      "Run `gsc-query` for the page to see its real queries.",
      "Rewrite title and meta description around the dominant query with a clear benefit; adjust H1 if needed.",
      SITE_CHANGE,
    ],
    tools: ["gsc-query", "check-meta"],
    done: "The new title/meta are live.",
    evidence: "Old vs new title and description.",
  },
  "opt:cluster-pick": {
    goal: "Plan a fresh cluster to restart growth in compounding mode.",
    steps: [
      "Pick a new theme from GSC queries and autocomplete.",
      "Add a pillar idea and 3 cluster ideas with `add-content`, each with a tracked keyword.",
    ],
    tools: ["gsc-query", "discover-keywords", "add-keywords", "add-content"],
    done: "A pillar and 3 cluster ideas exist with keywords.",
    evidence: "Theme and content ids.",
  },
  custom: {
    goal: "Complete the task as described.",
    steps: [
      "Read the description. Use the SEO tools that fit.",
      "Record results in the sprint (keywords, backlinks, content, findings) where they belong.",
    ],
    tools: ["today", "get-sprint"],
    done: "What the description asks for is done.",
    evidence: "Links and a short summary.",
  },
};

export function playbookFor(key: string | null | undefined): Playbook {
  return (key && PLAYBOOKS[key]) || PLAYBOOKS.custom!;
}

/** Full tool name as agents see it. */
export function qualifiedTool(name: string): string {
  return name.includes(":") ? name : `partnersinbiz.seo:${name}`;
}
