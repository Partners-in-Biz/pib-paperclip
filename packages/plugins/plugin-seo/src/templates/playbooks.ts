/**
 * Playbooks for every task of the 90-day plans (software, local service,
 * professional services and online shop; see plans.ts) and for the task types
 * the optimization loop generates. A task key means the same work in every
 * plan, so each key has one playbook. They feed two places:
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
  "First read `get-client-facts`: describe how the business works (bidding, ownership, reserves, fees, delivery, guarantees, inspection, legal or licence wording) ONLY with an approved wording from the fact sheet, otherwise leave the claim out; `create-preview` refuses anything else. Decide what the change is, then hand the BUILD to a developer with `request-build` (Developer; level senior for theme or template work, many pages or ecommerce): they branch (`seo/<task>`), commit, push and open the PR; you do not build it yourself and you end your turn until they report back (the issue's Site repo section and skill `references/site-changes.md` describe the repo flow). When they report the PR: wait for CI and the preview, verify on the preview with the check tools, `check-change-scope`, then run `page-diff` on every page the change touches (live address against the preview or staging address) and put its result in the evidence: an element it lists as lost (a table, a ranking, a form, an image, internal links, structured data) is restored unless you name it as removed on purpose with the reason. Then merge when `check-change-scope` says merge (or add the PR to Needs you). No repo link (site access none): write the exact change set and add it to Needs you with `needs-you-add`.";

const AFTER_DEPLOY = "After the deploy, re-run the same checks on production and `complete-task` with the PR link, the commit and the check output.";

/**
 * The Social agent owns repurposing: SEO marks the post live (which hands it
 * to Social once the page answers 200) and links the drafts Social made.
 */
function socialHandOff(post: string, publishKey: string): Playbook {
  return {
    goal: `${post[0]!.toUpperCase()}${post.slice(1)} reaches social: it is marked live, the Social agent repurposes it, and its social posts are linked to the content row.`,
    steps: [
      `\`list-content\`: find ${post} (the row of the \`${publishKey}\` task). If the page is live but the row is not, \`update-content\` with status \`live\` and the live \`targetUrl\`. That hands it to Social as soon as the page answers 200; the answer's \`socialHandOff\` says sent, or what it is waiting for.`,
      "Social owns repurposing: the Social agent gets one \"Repurpose for social\" issue in this sprint's client scope, drafts the LinkedIn, X and Instagram posts, and a person approves them there. Do not draft social posts yourself.",
      "When the drafts exist (their ids are on the closed Repurpose issue, or `partnersinbiz.social:list-posts` with this sprint's client: posts linking to the page with utm_campaign=seo-repurpose), `link-social-post` each one to the content row with its platform.",
      "No drafts yet on this run: leave the task in progress and look again on the next run. If `today` says Social was never told (the page does not answer 200), fix the URL or the deploy first.",
    ],
    tools: ["list-content", "update-content", "link-social-post", "partnersinbiz.social:list-posts"],
    done: `${post[0]!.toUpperCase()}${post.slice(1)}'s content row is live and lists its linked social posts.`,
    evidence: "The content row id, the live URL and the linked social post ids.",
  };
}

/** The re-checks: the same questions asked again against the baseline, with a fresh readiness audit (weeks 8 and 13, then monthly). */
function geoRecheck(day90: boolean): Playbook {
  return {
    goal: `See whether the work moved the answers: the same questions asked again, compared with the baseline, and a fresh readiness check${day90 ? ", for the day-90 report" : ""}.`,
    steps: [
      "Run `geo-audit` with sprintId.",
      "Ask the same questions as the baseline (`list-ai-mentions` lists them) with the same assistants or tools, and record them with `record-ai-mentions`. The latest answer per question and assistant is the one that counts in the rate; the baseline day stays for the trend.",
      "Compare with `list-ai-mentions`: the baseline rate, the latest rate and the change in points. Name what moved and the competitors that still appear. Say plainly when nothing moved: a handful of samples is a signal, not a measurement.",
      "Ranking watch: open every third-party ranking the w3 query map showed the business listed in. Check it is still listed and at which position. Flag removals, drops, and rankings whose title still carries last year (draft a refresh request to the site owner on Needs you). Then run the w3 searches again and note rankings that are new.",
      "For each gap you can explain (a page that does not answer the question, a missing profile, a blocked crawler) `add-task` with the cause." + (day90 ? " Include the readiness score and the mention rate in the day-90 report (`post-digest`), next to the GA4 organic numbers when GA4 is connected (`list-ga4-summary`)." : ""),
    ],
    tools: ["geo-audit", "list-ai-mentions", "record-ai-mentions", "add-task", ...(day90 ? ["list-ga4-summary"] : [])],
    done: "A readiness audit from the last 14 days exists and at least 5 questions were sampled in the last 14 days (complete-task checks this).",
    evidence: "The readiness score and the mention rate before and after, and the questions that changed.",
  };
}

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
    goal: "Home page carries valid Organization/WebSite JSON-LD plus the schema type that fits the business (SoftwareApplication for software, LocalBusiness or a more specific type for a local business, ProfessionalService/LegalService/AccountingService for a firm, Product and Organization for a shop) and an FAQPage block where the page has FAQs.",
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
      "WordPress site with the PiB Connector (site access `wordpress`): this is your work, not the client's. `gsc-verification-token` (method META, property url) → `partnersinbiz.crm:wp-verify` op get, then op set with the existing metaTags plus `{ name: \"google-site-verification\", content }` and a reason → `check-meta` on the live home page → `gsc-verify-site`. The service account becomes a verified owner of the URL-prefix property; nobody grants anything. A Connector older than 1.2 (wp-verify says a route is missing): `partnersinbiz.crm:wp-connector` op update first. `gsc-check-access` does not email the client on such a site until this route has failed.",
      "Client site without repo access (not WordPress): `gsc-check-access` puts the ready-to-send email (service account email + Search Console Users link) on the Needs you digest. Block this task with `block-task`; it comes back when the plugin sees access.",
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
      "Run `indexnow-key`. If the key file is not live, add it through the repo (`public/<key>.txt`; SEO scope), merge when checks pass, and wait for the deploy. On a WordPress site with the Connector: `partnersinbiz.crm:wp-verify` op get, then op set with the existing files plus `{ path: \"/<key>.txt\", content: \"<key>\" }` and a reason, then run `indexnow-key` again to confirm it is live. Never a Needs you item.",
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
      "Add the returned BingSiteAuth.xml (`public/BingSiteAuth.xml`) or the msvalidate.01 meta tag through the repo (SEO scope), merge when checks pass, wait for the deploy. On a WordPress site with the Connector: `partnersinbiz.crm:wp-verify` op get, then op set with the existing entries plus `metaTags [{ name: \"msvalidate.01\", content }]` (or `files [{ path: \"/BingSiteAuth.xml\", content }]`) and a reason; fetch the live tag or file. Never a Needs you item.",
      "Run `bing-verify-site`: it verifies, enables Bing on the sprint and submits the sitemap.",
      "(Import from Google Search Console is not available in the Bing API; the XML file is the API route.)",
    ],
    tools: ["bing-add-site", "bing-verify-site", "bing-submit", "check-change-scope", "check-meta"],
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
    goal: "Private and thin pages are noindexed and not in the sitemap: login, dashboard, onboarding and account pages, cart and checkout, thank-you pages, admin pages, internal search and filter pages.",
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
      "Collect 3–6 seed terms from the site and the client's services (`partnersinbiz.crm:get-client-profile`). Seeds by plan: local — each service plus the town or suburb, and 'near me'; professional — the service plus the city, and the questions clients ask before they hire; online shop — product types, brands and 'buy' or 'price' words; software — the problem, 'alternative to' and 'vs'.",
      "Run `discover-keywords` with the seeds (Google Autocomplete + seed variants). If GSC is connected, add queries from `gsc-query`.",
      "Judge winnability by looking at the current top results; record your DR estimate in difficultyDr when you have one. Never invent search volume: leave volume empty unless you have a real source.",
      "Save the shortlist with `add-keywords` (phrase, intent, optional difficultyDr, notes).",
    ],
    tools: ["discover-keywords", "gsc-query", "add-keywords", "list-keywords", "partnersinbiz.crm:get-client-profile"],
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
    goal: "The home page targets the primary keyword (for a local business: the main service and the town): in the title, H1 and first paragraph, with a clear offer and internal links to core pages.",
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
      "Before you write anything for a keyword, run `page-for-keyword`: when it says optimise or merge, improve that page and add its secondary keywords to the title and sections instead of creating a second page (record the decision in the task summary).",
      "Choose the keyword (priority, solution intent).",
      "Outline: problem → how the client solves it → proof (cases, reviews) → FAQ → call to action.",
      "Write the page; link it from the home page.",
      SITE_CHANGE,
      "Record it with `add-content` (type use-case, targetKeywordId, targetUrl, status live when published) and set the keyword's targetUrl.",
    ],
    tools: ["list-keywords", "add-content", "update-content", "update-keyword", "check-meta", "page-for-keyword", "page-diff"],
    done: "The page is live, passes `check-meta`, and is linked from the home page.",
    evidence: "URL, target keyword, PR or handoff.",
  },
  "w3-comparison-page": {
    goal: "A fair 'client vs category leader' (or 'alternatives to X') page for a solution keyword.",
    steps: [
      "Before you write anything for a keyword, run `page-for-keyword`: when it says optimise or merge, improve that page and add its secondary keywords to the title and sections instead of creating a second page (record the decision in the task summary).",
      "Pick the competitor people actually compare against (autocomplete 'vs' results help).",
      "Write an honest comparison table, who each option is best for, pricing notes with dates, FAQ.",
      SITE_CHANGE,
      "Record it with `add-content` (type comparison) and set the keyword's targetUrl.",
    ],
    tools: ["discover-keywords", "add-content", "update-keyword", "check-meta", "page-for-keyword", "page-diff"],
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
      "Before you write anything for a keyword, run `page-for-keyword`: when it says optimise or merge, improve that page and add its secondary keywords to the title and sections instead of creating a second page (record the decision in the task summary).",
      "Pick the next priority keyword without content (`list-keywords`, `list-content`).",
      "Write the post (1,200+ words, real facts, comparison table, FAQ, links to core pages).",
      "Create/update the content row: status drafting → review.",
      "Write it on a `seo/<task>` branch and open the PR; the Vercel preview is the draft. Safe mode: `block-task` with `review: true` and the preview link (the brief/draft needs sign-off). Once the owner approves (issue done or a comment), merge — a new post from an approved brief is SEO scope. Full mode: merge when checks pass.",
      "When live: `update-content` status live, targetUrl, publishOn.",
    ],
    tools: ["list-keywords", "list-content", "add-content", "update-content", "check-meta", "page-for-keyword", "page-diff"],
    done: "The post is live and its content row is status live with its URL.",
    evidence: "Draft link, live URL, target keyword.",
  },
  "w5-repurpose-1": socialHandOff("post 1", "w5-post-1"),
  "w6-post-2": {
    goal: "Publish the second post in a use-case format for a priority keyword.",
    steps: [
      "Before you write anything for a keyword, run `page-for-keyword`: when it says optimise or merge, improve that page and add its secondary keywords to the title and sections instead of creating a second page (record the decision in the task summary).",
      "Same flow as post 1: pick keyword → write → content row → review handoff (safe) or publish (full) → mark live.",
      "Link to the pillar-to-be and core pages.",
    ],
    tools: ["list-keywords", "list-content", "add-content", "update-content", "check-meta", "page-for-keyword", "page-diff"],
    done: "The post is live and recorded.",
    evidence: "Live URL and target keyword.",
  },
  "w6-repurpose-2": socialHandOff("post 2", "w6-post-2"),
  "w7-pillar": {
    goal: "Publish a 2,000+ word pillar page covering the core topic end to end, linking out to every related post and core page.",
    steps: [
      "Before you write anything for a keyword, run `page-for-keyword`: when it says optimise or merge, improve that page and add its secondary keywords to the title and sections instead of creating a second page (record the decision in the task summary).",
      "Choose the topic that the most tracked keywords roll up to.",
      "Outline sections that each could become a cluster post; write with real examples and data.",
      "Content row type pillar; review handoff in safe mode; publish when approved.",
      "Mark live with URL.",
    ],
    tools: ["list-keywords", "add-content", "update-content", "validate-schema", "page-for-keyword", "page-diff"],
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
      "One page per run, never a batch: duplicate the reference page, replace every place-specific or item-specific fact (local details, prices, examples, proof), run `page-diff` against the REFERENCE page and restore anything the reference had that the new page lost. A page that only swaps the name does not ship.",
      "Before you write anything for a keyword, run `page-for-keyword`: when it says optimise or merge, improve that page and add its secondary keywords to the title and sections instead of creating a second page (record the decision in the task summary).",
      "List the features/services worth a page (from the site and CRM).",
      "Design the template: H1 pattern, sections, FAQ, schema, internal links.",
      "Write the first 3–5 pages; no thin duplicates.",
      "Safe mode: review handoff before launch.",
      "Record each as content (type feature).",
    ],
    tools: ["add-content", "check-meta", "validate-schema", "page-for-keyword", "page-diff"],
    done: "At least 3 feature pages are live and recorded.",
    evidence: "URLs.",
  },
  "w8-pseo-comparison": {
    goal: "A template for 'alternative to X' / 'client vs X' pages, launched for the top competitors.",
    steps: [
      "One page per run, never a batch: duplicate the reference page, replace every place-specific or item-specific fact (local details, prices, examples, proof), run `page-diff` against the REFERENCE page and restore anything the reference had that the new page lost. A page that only swaps the name does not ship.",
      "Before you write anything for a keyword, run `page-for-keyword`: when it says optimise or merge, improve that page and add its secondary keywords to the title and sections instead of creating a second page (record the decision in the task summary).",
      "Use autocomplete (`discover-keywords` with competitor names) to find real comparison searches.",
      "Build the template with an honest table and who-it-suits sections.",
      "Launch 3+ pages; review handoff in safe mode.",
      "Record each as content (type alternative or comparison) with its keyword.",
    ],
    tools: ["discover-keywords", "add-keywords", "add-content", "page-for-keyword", "page-diff"],
    done: "At least 3 comparison/alternative pages are live and recorded.",
    evidence: "URLs and target keywords.",
  },
  "w9-directories": {
    goal: "Real directory listings: every seeded directory is submitted (with proof), live, or rejected as irrelevant — no status-only changes.",
    steps: [
      "`list-backlinks` (types directory and citation). The seeded sources fit the sprint's plan (software, local service, professional services or online shop), but check each one for this client: mark one that does not fit `rejected` with notes 'not relevant', and add better ones (industry bodies, local or trade directories) with `add-backlink`.",
      "Prepare one listing kit: the exact business name, address and phone (the same as the sprint notes and the Google Business Profile), one-line and long description, categories, hours or service area, logo URL, photos or screenshots, pricing, contact, founding year. Put it in a comment on this issue.",
      "Directories need accounts, email verification and often CAPTCHAs: hand off with `block-task` listing the directories and the kit, unless the owner has told you in the sprint notes that you may submit.",
      "For each submission record `update-backlink` status submitted with notes (submission URL, date, account used). When a listing appears, status live with its URL.",
    ],
    tools: ["list-backlinks", "update-backlink", "add-backlink"],
    done: "No directory or citation is still not started (complete-task checks this).",
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
    goal: "Share the site where the audience already is — local community groups for a local business, LinkedIn and industry forums for a firm, buyer forums and groups for a shop, IndieHackers and relevant subreddits for software — with a useful post, not spam.",
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
      "Before you write anything for a keyword, run `page-for-keyword`: when it says optimise or merge, improve that page and add its secondary keywords to the title and sections instead of creating a second page (record the decision in the task summary).",
      "Write each cluster post; link to the pillar and sibling posts.",
      "Safe mode: review handoff per batch.",
      "When live: `update-content` status live, targetUrl, linksToPillarIds with the pillar id.",
    ],
    tools: ["list-content", "update-content", "internal-link-audit", "page-for-keyword", "page-diff"],
    done: "At least 5 cluster posts are live and each lists the pillar in linksToPillarIds.",
    evidence: "Live URLs.",
  },
  "w13-audit-metrics": {
    goal: "A Day 90 snapshot of traffic, rankings, authority and content.",
    steps: [
      "The daily job records the day-90 snapshot automatically on day 90. Run `gsc-pull` first if GSC is connected, then `run-audit-snapshot` (day 90) if it is missing or stale.",
      "Compare with the day 0/30/60 snapshots (`audit-summary`). Where a person switched them on for the sprint, a snapshot also carries the AI-search readiness score (`geo`) and the organic traffic and key events from GA4 (`analytics`).",
    ],
    tools: ["gsc-pull", "run-audit-snapshot", "audit-summary"],
    done: "A snapshot for day 90 (or later) exists (complete-task checks this).",
    evidence: "Snapshot id and the headline numbers vs day 0.",
  },
  "w13-audit-report": {
    goal: "A short Day 90 report the client can read: what was done, what moved, what is next.",
    steps: [
      "Use `audit-summary` and the snapshots; list wins (keywords in top 10, impressions growth, links live) with real numbers only. Where AI search is switched on for the sprint (`get-switches`), add the AI-search readiness score and how often AI answers named the business (`list-ai-mentions`); where Google Analytics is on and connected, add the organic sessions and key events and which of them landed on the pages this sprint made (`list-ga4-summary`).",
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

  // --- Local service, professional services and online shop plans -------------
  "w0-gbp-claim": {
    goal: "The business has one verified Google Business Profile that the owner controls, with Partners in Biz added as a manager, so it shows in Google Maps and the local results.",
    steps: [
      "Search Google Maps and Google for the business name and phone number: is there a profile already (or a duplicate)? Note its link.",
      "Read the client profile (`partnersinbiz.crm:get-client-profile` with the sprint's client) and the site: the exact business name, address or service area, phone, hours, main category and services. That is the one name, address and phone (NAP) every listing uses; task `w0-nap` puts the same on the site.",
      "Claiming and verifying needs the owner's Google account (Google sends a code by post, phone or video). Add one Needs you item with `needs-you-add` (kind grant, key `gbp_claim`): the profile link or https://business.google.com/create, the exact details to enter, the categories, and 'add Partners in Biz as a manager'. Then `block-task` with that ask; the task comes back when the item is done.",
      "When it is done, check the profile is live on Google Maps and record it: `update-backlink` on the seeded Google Business Profile row (status live, url = the Maps link), or `add-backlink` (type citation) if there is no row.",
    ],
    tools: ["needs-you-add", "block-task", "list-backlinks", "update-backlink", "add-backlink", "partnersinbiz.crm:get-client-profile"],
    done: "A verified profile exists, Partners in Biz is a manager, and its Maps link is recorded on the Backlinks tab.",
    evidence: "The Maps link, the verification date and the name, address and phone used.",
  },
  "w0-nap": {
    goal: "One exact business name, address (or service area) and phone number appears the same way on every page, in the schema and on every listing.",
    steps: [
      "Decide the name, address and phone from the client profile (`partnersinbiz.crm:get-client-profile`), the Google Business Profile and the site. Save them in the sprint notes with `update-sprint` so every later task uses the same spelling.",
      "Run `crawler-sim` on the home and contact pages and find every place the name, address or phone appears (header, footer, contact page, schema).",
      "Make them match exactly, add click-to-call (`tel:`) links and the address in the footer.",
      SITE_CHANGE,
      "Add or fix the LocalBusiness address and telephone in the JSON-LD and run `validate-schema`.",
    ],
    tools: ["crawler-sim", "validate-schema", "update-sprint", "check-change-scope", "partnersinbiz.crm:get-client-profile"],
    done: "The home page, the contact page and the schema show the same name, address and phone as the sprint notes.",
    evidence: "The name, address and phone, the pages changed, and the PR or change set.",
  },
  "w0-merchant-center": {
    goal: "The shop's products show for free in Google Shopping: a verified Google Merchant Center account with a working product feed.",
    steps: [
      "Find out the shop platform (Shopify, WooCommerce and most others have a Google channel or plugin that builds the feed) and what the site already has.",
      "The account needs the owner's Google account and business details. Add one Needs you item (`needs-you-add`, kind grant, key `merchant_center`) with the exact steps: create the account at https://merchants.google.com, verify and claim the site (the verification tag can go in through the repo: SEO scope), add Partners in Biz as a user, and turn on free listings. Then `block-task`.",
      "Once the account exists: connect the product feed (the platform's channel, or a feed file the site serves: `add-task` a code task if it needs code) and fix the feed errors Merchant Center lists (missing brand or GTIN, price or stock that differs from the page, image problems).",
      "Record it with `update-backlink` on the seeded Google Merchant Center row (status live, url = a product on Google Shopping).",
    ],
    tools: ["needs-you-add", "block-task", "add-task", "update-backlink", "validate-schema"],
    done: "Free listings are on and the feed has no account-level errors.",
    evidence: "Products approved and not approved, and the fixes made.",
  },
  "w3-service-pages": {
    goal: "One strong page per main service or practice area, each built around its own keyword: what it is, who it is for, how pricing works, proof, FAQ and a clear way to book or call.",
    steps: [
      "Before you write anything for a keyword, run `page-for-keyword`: when it says optimise or merge, improve that page and add its secondary keywords to the title and sections instead of creating a second page (record the decision in the task summary).",
      "List the services from the client profile (`partnersinbiz.crm:get-client-profile`) and the site, and match each to a tracked keyword (`list-keywords`). Merge small services into one page rather than writing thin pages.",
      "Write each page with real facts only (no invented prices, results or reviews): the service, who it suits, the process, how pricing works, proof, FAQ and the call to action. A local business names its town or area.",
      SITE_CHANGE,
      "Record each page with `add-content` (type page, targetKeywordId, targetUrl, status live when published) and set the keyword's targetUrl with `update-keyword`.",
    ],
    tools: ["list-keywords", "add-content", "update-content", "update-keyword", "check-meta", "partnersinbiz.crm:get-client-profile", "page-for-keyword", "page-diff"],
    done: "Every main service has a live page that passes `check-meta` and is linked from the home page.",
    evidence: "The service page URLs and their keywords.",
  },
  "w3-contact-page": {
    goal: "The contact page makes it easy to find, call and book: the same name, address and phone, a map, opening hours, the areas served, the booking link and a review link.",
    steps: [
      "Check the page with `crawler-sim` and `check-meta`.",
      "Add what is missing: the name, address and phone from the sprint notes, click-to-call, a Google Map of the business, opening hours, the areas served, the booking link from the client profile, and a 'Leave us a review' link.",
      SITE_CHANGE,
      "Make sure the LocalBusiness schema matches (`validate-schema`).",
    ],
    tools: ["crawler-sim", "check-meta", "validate-schema", "check-change-scope", "partnersinbiz.crm:get-client-profile"],
    done: "The live contact page shows the name, address, phone, map, hours and booking link, and the schema validates.",
    evidence: "The page URL, what was added, and the PR or change set.",
  },
  "w3-team-page": {
    goal: "Real expertise is visible: a team or about page with each expert's name, photo, qualifications, registrations (for example admitted attorney, CA(SA)) and experience, linked from every service page.",
    steps: [
      "Collect the facts from the site, LinkedIn and the client profile. Never invent a qualification: what you cannot confirm goes to the owner as one question on Needs you (`needs-you-add`, kind task).",
      "Write short, plain bios (the credentials clients look for first) and add Person schema for each expert.",
      SITE_CHANGE,
      "Link the page from each service page and record it with `add-content` (type page).",
    ],
    tools: ["crawler-sim", "validate-schema", "add-content", "needs-you-add", "check-change-scope"],
    done: "The team page is live with confirmed credentials and is linked from the service pages.",
    evidence: "The page URL and the people listed.",
  },
  "w3-category-pages": {
    goal: "The top 5 category pages can rank for their category keywords: a short unique intro, buying notes, FAQ and links to the best products and guides, not only a product grid.",
    steps: [
      "Pick the 5 categories with the most search demand (tracked keywords, and `gsc-query` once Search Console is connected).",
      "Write a short unique intro (what is in the range, who it suits), 3–5 FAQs and links to related categories and guides. Keep the products at the top of the page.",
      SITE_CHANGE,
      "Record each with `add-content` (type page) and set the keyword's targetUrl with `update-keyword`.",
    ],
    tools: ["list-keywords", "gsc-query", "add-content", "update-keyword", "check-meta", "validate-schema"],
    done: "5 category pages are live with unique copy and FAQ, and pass `check-meta`.",
    evidence: "The category URLs and their keywords.",
  },
  "w3-product-pages": {
    goal: "The 10 most-searched product pages have unique descriptions (not the supplier's copy), full specs, good photos with alt text, price and stock, and valid Product schema.",
    steps: [
      "Pick the 10 products from the tracked keywords and Search Console impressions (`gsc-query` by page when connected).",
      "Rewrite each description around what buyers ask; add specs, sizes, delivery and returns notes. Never invent reviews or ratings.",
      SITE_CHANGE,
      "Run `validate-schema` on each page: Product with offers (price, currency ZAR, availability), and review data only where real reviews exist.",
    ],
    tools: ["gsc-query", "validate-schema", "check-meta", "crawler-sim", "check-change-scope"],
    done: "10 product pages are live with unique copy and valid Product schema.",
    evidence: "The product URLs and the schema check.",
  },
  "w4-gbp-complete": {
    goal: "The Google Business Profile is complete and matches the site: categories, services with descriptions, hours, service area, photos, booking link and a description with the main service and town.",
    steps: [
      "Write the full profile content in one go: primary and extra categories, a description of up to 750 characters with the main service and town, each service with a short description, hours, the areas served, the booking link, and a list of 10 photos to add (real ones from the site, or ones the owner can take).",
      "There is no API for us to edit the profile. Put the content on Needs you once (`needs-you-add`, kind task, key `gbp_complete`, the text in `copy`) for whoever manages the profile, then `block-task`.",
      "When it is done, compare the profile with the site's name, address, phone and hours, and fix the site if they differ.",
      "Record the profile's Maps link on the Backlinks tab (`update-backlink`, status live) if it is not there yet.",
    ],
    tools: ["needs-you-add", "block-task", "update-backlink", "crawler-sim"],
    done: "The profile lists every service, the hours and the booking link, and matches the site.",
    evidence: "The Maps link and what was added.",
  },
  "w4-case-studies": {
    goal: "Two short case studies or client stories show real results, with the client's permission: the problem, what was done and the outcome, in plain words.",
    steps: [
      "Find candidate stories on the site, in the client profile and in past work. Naming a client needs permission: ask the owner once on Needs you (`needs-you-add`, kind task) with the stories and what you need (may we name them? share numbers?).",
      "Write each story in 300–600 words: the situation, the approach, the result, and a quote only if the client gave one. Leave out names when there is no permission.",
      "Write it on a `seo/<task>` branch and open the PR. Safe mode: `block-task` with `review: true` and the preview link; merge once approved.",
      "Record each with `add-content` (type page) and link it from the related service pages.",
    ],
    tools: ["needs-you-add", "block-task", "add-content", "update-content", "check-meta"],
    done: "Two approved case studies are live and linked from the service pages.",
    evidence: "The URLs and the permission note.",
  },
  "w4-product-reviews": {
    goal: "Real product reviews show on the product pages and in the Product schema, so Google can show stars.",
    steps: [
      "Find out how the shop collects reviews (the platform's reviews app, Google Customer Reviews, Hellopeter) and whether reviews show on product pages (`crawler-sim`).",
      "Reviews exist but do not show: switch on the platform's review display or add them to the product template, and add aggregateRating to the Product schema only from real reviews.",
      SITE_CHANGE,
      "No way to collect reviews yet: the setup needs the owner's account, so add it to Needs you (`needs-you-add`, kind grant) with the exact steps.",
    ],
    tools: ["crawler-sim", "validate-schema", "needs-you-add", "check-change-scope"],
    done: "Product pages with reviews show them and `validate-schema` finds a valid aggregateRating.",
    evidence: "The pages checked and the schema result.",
  },
  "w6-reviews": {
    goal: "A steady flow of genuine Google reviews: happy customers get a short request with the direct review link. Never buy, filter or write reviews.",
    steps: [
      "Get the direct review link of the Google Business Profile (Google Business Profile → Ask for reviews). If we do not manage the profile, that step goes on Needs you.",
      "Write a short, friendly request in the client's voice (`partnersinbiz.crm:get-client-profile`): thanks, the link, and one line on why it helps. Make an email and a WhatsApp version.",
      "Add a /review page or QR code that sends people to the review link (a small site change through the repo).",
      "The client's customers are theirs: put the request on Needs you (`needs-you-add`, kind message, the text in `copy`) for the owner to send after each job. For our own sites, draft a campaign to recent customers with `partnersinbiz.campaigns:create-campaign` and `partnersinbiz.campaigns:request-campaign-approval` (the approval is the sign-off).",
      "Note the review count at the start in the completion summary, so the day-90 report can compare.",
    ],
    tools: ["needs-you-add", "block-task", "partnersinbiz.crm:get-client-profile", "partnersinbiz.campaigns:create-campaign", "partnersinbiz.campaigns:request-campaign-approval", "check-change-scope"],
    done: "The request and the review link are with the owner (or the campaign is approved), and the starting review count is noted.",
    evidence: "The review link, the request text and the starting count.",
  },
  "w8-area-pages": {
    goal: "One genuinely useful page per main town, suburb or region served: the services offered there, local details, travel or call-out notes and local proof. Never copy-paste pages that only swap the place name.",
    steps: [
      "One page per run, never a batch: duplicate the reference page, replace every place-specific or item-specific fact (local details, prices, examples, proof), run `page-diff` against the REFERENCE page and restore anything the reference had that the new page lost. A page that only swaps the name does not ship.",
      "Before you write anything for a keyword, run `page-for-keyword`: when it says optimise or merge, improve that page and add its secondary keywords to the title and sections instead of creating a second page (record the decision in the task summary).",
      "List the areas from the client profile, the Google Business Profile's service area and Search Console queries with place names (`gsc-query` with the town in `query`).",
      "Pick at most 5–8 areas with real demand. Write unique content for each: what you do there, local context, travel time or call-out fee, and reviews from customers there.",
      "Build them from one template. Safe mode: `block-task` with `review: true` and the preview before they go live.",
      "Record each with `add-content` (type page) and track its keyword with `add-keywords` (with targetUrl).",
    ],
    tools: ["gsc-query", "discover-keywords", "add-keywords", "add-content", "check-meta", "validate-schema", "page-for-keyword", "page-diff"],
    done: "The area pages are live, each with unique content and a tracked keyword.",
    evidence: "The URLs and their keywords.",
  },
  "w8-industry-listings": {
    goal: "The business is listed where its own industry looks: professional bodies, associations and industry booking sites (for example the Legal Practice Council for attorneys, SAICA for accountants, the Biokinetics Association for biokineticists, LekkeSlaap or SafariNow for guest houses).",
    steps: [
      "Find the 3–6 bodies and industry sites that matter for this client's trade in South Africa, and whether they list members or businesses.",
      "Record each target with `add-backlink` (type citation or directory, status not_started, notes with what it needs: a membership number or an account).",
      "Submit the ones you can yourself. Listings that need the owner's login or membership details go on Needs you in one item (`needs-you-add`, kind task) with the exact details to enter.",
      "Mark each one submitted, live (with the listing URL) or rejected with the reason (`update-backlink`).",
    ],
    tools: ["add-backlink", "update-backlink", "list-backlinks", "needs-you-add"],
    done: "Every relevant industry listing is live, submitted, or on Needs you with the exact details.",
    evidence: "Each listing's status and URL.",
  },
  "w8-collection-pages": {
    goal: "Collection pages for real searches (by use, style, brand or price, for example 'hiking boots for women') that list the right products under a short unique intro.",
    steps: [
      "Find real searches with `discover-keywords` on the main categories (and `gsc-query` once Search Console is connected).",
      "Create 5–10 collections that match those searches, each with a unique intro and FAQ. A collection that would copy an existing category points its canonical tag to that category instead.",
      "Safe mode: `block-task` with `review: true` and the preview before they go live.",
      "Record each with `add-content` (type page) and track its keyword with `add-keywords`.",
    ],
    tools: ["discover-keywords", "gsc-query", "add-keywords", "add-content", "check-canonical", "check-meta"],
    done: "At least 5 collection pages are live, each with a tracked keyword.",
    evidence: "The URLs and their keywords.",
  },
  "w9-partner-links": {
    goal: "Three relevant partners link to the site: suppliers, venues, clubs, referral partners or the brands a shop stocks. Never paid links or link farms.",
    steps: [
      "Find 3–5 partners the business already works with: the client profile and the site (partners, suppliers, sponsors), and CRM records with sites (`partnersinbiz.crm:find-records`).",
      "Record each with `add-backlink` (type link_trade or organic, status not_started, notes with the person and where the link would go: a partner page, a 'where to buy' list, a supplier directory).",
      "Write one short, personal message per partner: where the link would go and why it helps their customers.",
      "The owner knows these people: put the messages on Needs you (`needs-you-add`, kind message, copy-ready). Safe mode: `block-task` with `review: true` pointing to it.",
      "Mark links live when they appear (`update-backlink` with the URL).",
    ],
    tools: ["add-backlink", "update-backlink", "needs-you-add", "block-task", "partnersinbiz.crm:find-records"],
    done: "3 partners are recorded with messages ready; agreed links are recorded.",
    evidence: "The partners, the message text and the outcomes.",
  },
  "w10-local-press": {
    goal: "One local story pitched to a local news site, community blog or radio station (a milestone, an event, local tips) for a genuine mention and link.",
    steps: [
      "Find 3–5 local outlets (the town's news site, community blogs, local news pages) and who takes story ideas.",
      "Draft a short pitch with one real story angle and the facts (no invented numbers), plus a photo idea.",
      "Safe mode: hand it over with `block-task` and `review: true`. The owner sends it, since it comes from them (or it goes on Needs you as a message).",
      "Record the outlet with `add-backlink` (type organic, status in_progress, notes with the contact and date) and mark it live when the story is up.",
    ],
    tools: ["add-backlink", "update-backlink", "needs-you-add", "block-task"],
    done: "The pitch is sent and recorded.",
    evidence: "The outlet, contact, pitch text and date.",
  },

  // --- Optimization task types -------------------------------------------------
  // GEO (AI search), template version 5 (templates/geo.ts). The checks behind them: tool geo-audit; samples: record-ai-mentions.
  "w0-geo-crawlers": {
    goal: "AI answer engines can read the site: robots.txt does not block the search crawlers of ChatGPT, Claude, Perplexity, Google, Bing or Apple, and the server does not refuse them.",
    steps: [
      "Run `geo-audit` with sprintId. Its crawlers section lists every AI crawler as allowed, partly blocked or blocked by robots.txt, and its server probes show whether a firewall or CDN refuses a bot that robots.txt allows (HTTP 403, or a bot-check page).",
      "Search crawlers (OAI-SearchBot, Claude-SearchBot, PerplexityBot, Googlebot, bingbot, Applebot) and the user agents (ChatGPT-User, Claude-User, Perplexity-User) that robots.txt blocks by mistake (a blanket rule, an old CMS default, a rule copied from another site) are fixed: remove or narrow the rule. robots.txt is SEO scope (WordPress: `wp-robots`). " + SITE_CHANGE,
      "Training crawlers (GPTBot, ClaudeBot, Google-Extended, Applebot-Extended, CCBot, Bytespider, meta-externalagent) are the client's policy, not a defect: report what robots.txt says and never change a rule for them yourself. Blocking them does not affect Google, Bing or the search crawlers above. If the client never decided, put the question on Needs you once (`needs-you-add`, kind message, with a two-line explanation).",
      "A server refusal is a firewall or CDN setting you cannot reach: `needs-you-add` (kind grant) naming the bots, the probe results and where to change it (for example Cloudflare → Security → Bots → AI Scrapers and Crawlers, or the host's bot protection). Carry on with everything else; `block-task` only when nothing else is left. The probe sees user-agent rules only: a block by IP range cannot be seen from here.",
      "Run `geo-audit` again after the deploy: findings you fixed resolve on their own.",
    ],
    tools: ["geo-audit", "check-robots", "crawler-sim", "check-change-scope", "needs-you-add"],
    done: "`geo-audit` shows every search and user crawler allowed and no server refusal, or each remaining one is on Needs you with the reason (complete-task checks that an audit was recorded in the last 14 days).",
    evidence: "The crawler table before and after, the PR or the Connector change ids, and the Needs you keys.",
  },
  "w1-geo-llms-txt": {
    goal: "The site serves a small llms.txt that lists its key pages for AI tools, or the task is skipped with the reason.",
    steps: [
      "Be honest about what it is: llms.txt is a proposed convention, and no major search engine or AI company has said it uses it to rank or cite a page. It is cheap, it carries 5% of the readiness score, and you never promise a result from it.",
      "Draft it from the real site: `# <business name>`, a one-line `> summary`, then `## ` sections (Services, About, Contact, Guides) with `- [Page title](https://absolute-url): what it covers` for 5 to 15 key pages (`check-sitemap`, `list-content`, the core pages). Only pages that exist and answer 200.",
      "Publish it at `/llms.txt` as plain text. Repo sites: a file in the public folder (a root key file: SEO scope). WordPress: `partnersinbiz.crm:wp-verify` op get, then op set with the existing files plus `{ path: \"/llms.txt\", content }`. If the Connector refuses the file name or the site cannot serve root files, `skip-task` with that reason: never a Needs you item. " + SITE_CHANGE,
      "Run `geo-audit`: the llms.txt section reads good and every listed page loads.",
    ],
    tools: ["geo-audit", "check-sitemap", "list-content", "check-change-scope", "skip-task"],
    done: "`geo-audit` reports llms.txt as good (title, summary, sections, working links), or the task is skipped with the reason.",
    evidence: "The file's URL and content, and the PR or the Connector change id.",
  },
  "w1-geo-entity": {
    goal: "The home page tells AI systems who the business is: Organization (or LocalBusiness / ProfessionalService) data with name, logo, description, phone or email, address, a stable @id and links to the business's real profiles (sameAs).",
    steps: [
      "Run `geo-audit` (entity section) and `validate-schema` on the home page: what exists and what is missing.",
      "Collect real facts only: the name exactly as the business writes it, the logo URL, a description in its own words, the phone, email and address the site shows (`get-client-facts` for approved wording), and the profile links that EXIST (LinkedIn, Facebook, Instagram, X, YouTube, Google Business Profile, Hellopeter; Wikipedia or Wikidata only if the business really has an entry). Never invent a profile, and never create one just to fill the field.",
      "Extend the existing Organization or LocalBusiness node instead of adding a second one (WordPress with Yoast or Rank Math: `wp-schema` with a stable id, joining their graph). Give it an `@id`, `logo`, `description`, `telephone` or `contactPoint`, `address`, `sameAs`, and link the WebSite node's publisher to it. " + SITE_CHANGE,
      "Re-run `geo-audit` and `validate-schema`.",
    ],
    tools: ["geo-audit", "validate-schema", "get-client-facts", "check-change-scope"],
    done: "`geo-audit`'s entity section scores 80 or more, or each missing item is named as not available, with why.",
    evidence: "The JSON-LD you added (or its PR) and the entity score before and after.",
  },
  "w2-geo-baseline": {
    goal: "A baseline: how AI assistants answer the questions this business's customers ask, and whether the business is named or cited.",
    steps: [
      "`list-ai-mentions` (with sprintId) suggests questions from the priority keywords and the business's own name. Add the real questions customers ask (`list-content`, the site's FAQ, `gsc-query` queries) until you have about 10.",
      "Ask each question with the answer tools you really have (a web search tool, a browser, an assistant's public page). Use only what you can run. If your run has no tool that returns an AI assistant's answer, do not guess: `skip-task` with that reason.",
      "Record each answer with `record-ai-mentions`: the query, the engine (which assistant or tool gave the answer), whether it named the business (`mentioned`) or listed a page of the site as a source (`cited`, with `citedUrls`), a short `evidence` quote, the competitors it named and how you got it (`method`). A mention without a quote or a source URL is refused. Never fill a gap with what an assistant would probably say.",
      "Read the result (`list-ai-mentions`): the rate and the competitors that appear instead. Put the two or three clearest gaps in the task summary.",
    ],
    tools: ["list-ai-mentions", "record-ai-mentions", "list-keywords", "list-content", "gsc-query", "skip-task"],
    done: "At least 5 questions are sampled and recorded with `record-ai-mentions` (complete-task checks this).",
    evidence: "The questions, the assistants or tools used, the mention rate and the competitors that appeared.",
  },
  "w3-geo-queries": {
    goal: "The list of searches an AI assistant runs for this business's customers, and for each one which ranking or review pages come up and whether the business is listed in them.",
    steps: [
      "Take the top 10 priority keywords that have commercial intent (`list-keywords`, intent solution). Skip informational keywords for this task.",
      "For each keyword build the searches assistants run: `best <keyword> <year>`, `best <keyword> <year> <country>`, the same two in English when the site is not in English, and for the business and its top 3 competitors `<name> reviews` and `<name> alternative`.",
      "Look up each search with the search tool you really have. List the top 10 results and mark which are rankings, listicles or review pages. For each of those: is the business listed, at which position, which domain hosts it. If your run has no search tool, `skip-task` with that reason. Never write a ranking you did not see.",
      "Write the map as a table in the task summary: search, ranking pages, listed yes or no, position, host domain. Add the 3 to 5 ranking pages that matter most as backlink targets with `add-backlink` (type guest_post or link_trade, status not_started, the page URL in notes).",
    ],
    tools: ["list-keywords", "add-backlink", "list-backlinks", "gsc-query", "skip-task"],
    done: "At least 5 searches are mapped with the ranking pages seen and whether the business is listed, or the task is skipped with the reason.",
    evidence: "The table of searches, the ranking pages found, and the backlink targets added.",
  },
  "w5-geo-self-rank": {
    goal: "No page of the site names the business first in a ranking it wrote itself unless that page earns clicks. Pages that earn clicks are left alone.",
    steps: [
      "List the pages whose title or H1 contains best, top, ranking or a year (`check-sitemap`, then `check-meta` on each). Open each and note who is listed first.",
      "For each page where the business is first: read its clicks over 90 days (`gsc-query` with page). A page with clicks is not touched: list it for the owner with its click count (`needs-you-add`, kind message).",
      "A page where the business is first and that earns no clicks: rewrite the ranking on the merits, with the business honestly placed, in the list but never first by default. One page per run, never a batch.",
      SITE_CHANGE,
      "Before the change goes to review run `page-diff` on the page. Rewriting a ranking is exactly where tables and rows get dropped: every lost row, table or link is restored.",
    ],
    tools: ["check-sitemap", "check-meta", "gsc-query", "page-diff", "needs-you-add", "check-change-scope"],
    done: "Every page where the business is first is either left alone with its click count on Needs you, or rewritten with a clean `page-diff`.",
    evidence: "The pages found, who was first, clicks per page, the pages rewritten and each page-diff summary.",
  },
  "w10-geo-outreach": {
    goal: "Third-party rankings that do not list the business get a personal, honest request, with every email drafted and approved by a person before anything is sent.",
    steps: [
      "Take the ranking pages from the w3 query map where the business is not listed, plus niche sites that rank for the business's commercial keywords but host no ranking yet.",
      "For each site find a real contact on its about, author or contact page. Never guess an address. No contact found means skip the site.",
      "Sort each lead: network blog, business site, pure-player media, or author opportunity. Write one short personal email per lead with one concrete offer: a business site gets a swap (we list them in our matching ranking), media gets a story or data they can use. Never ask a site to say the business is the best.",
      "Write the leads as a table in the task summary (email, first name, site, ranking URL, rung, personal first line) and the drafts under it. Send nothing.",
      "Hand it to a person: `needs-you-add` (kind message) with the drafts in `copy`. When the Campaigns module is on, also put the leads in a campaign (`partnersinbiz.campaigns:create-campaign`, then `request-campaign-approval`): Campaigns refuses to launch without approval, caps the daily volume and stops on a reply. Pace is at most 10 new leads a day.",
      "When replies arrive, classify them (yes, question, no, wrong person), draft the answer and put it on Needs you. Record agreed links with `update-backlink`.",
    ],
    tools: ["list-backlinks", "add-backlink", "update-backlink", "needs-you-add", "list-keywords"],
    done: "Leads and drafts are recorded and with a person for approval; nothing was sent by the agent.",
    evidence: "The lead table, the Needs you item or campaign id, and replies handled.",
  },
  "w4-geo-answers": {
    goal: "The core pages answer the questions customers ask in a short, quotable block, and FAQ markup describes only questions the page really shows.",
    steps: [
      "`geo-audit` (answers section) shows, for the home page and a sample of core pages, the question headings, how many have a direct answer and the state of the FAQ markup. `list-ai-mentions` shows the questions where the business was missing.",
      "Under each main question heading on a core page, put a direct answer of 2 to 3 sentences (about 30 to 60 words) that stands on its own: the answer first, then the detail. Real questions only (the FAQ, `gsc-query`, the sampled questions). Facts only from `get-client-facts` and the site: no invented prices, numbers or promises.",
      "FAQPage markup only for questions the page shows (3 or more), word for word. Remove markup for questions that are not visible (Google ignores it and may flag the site).",
      SITE_CHANGE,
      "Re-run `geo-audit` (answers section) and `validate-schema`.",
    ],
    tools: ["geo-audit", "list-ai-mentions", "get-client-facts", "validate-schema", "gsc-query", "check-change-scope"],
    done: "`geo-audit` finds a short direct answer under at least 2 questions on each core page, and no FAQ markup for hidden questions.",
    evidence: "The pages changed, the questions answered, and the PR or the Connector change ids.",
  },
  "w6-geo-brand": {
    goal: "The business is described the same way everywhere AI systems look: the site, its social profiles and the directories it is listed in (same name, phone, address and a one-sentence description).",
    steps: [
      "Run `geo-audit` (brand section): sameAs links that fail or show another name, and directory listings (`list-backlinks`, type directory or citation, status live) that miss the site's name or phone.",
      "Fix the site first so the canonical version is right (the schema, the footer, the contact page). Then write what each profile and listing must say: name, phone, address, website and one sentence (client facts only).",
      "A correction on a third-party profile needs the owner's login: prepare the exact text per listing and put the one grant on Needs you (`needs-you-add`, kind message, copy-ready), as the directory tasks do. A listing you can reach yourself: fix it.",
      "Remove or correct a sameAs link that fails; add the real profiles that are missing. " + SITE_CHANGE,
      "Run `geo-audit` again: the findings for corrected listings resolve.",
    ],
    tools: ["geo-audit", "list-backlinks", "update-backlink", "needs-you-add", "get-client-facts", "validate-schema"],
    done: "`geo-audit` finds no listing or profile with a different name or phone and no broken sameAs link, or each remaining one is on Needs you.",
    evidence: "The listings corrected, the listings waiting on a login (Needs you keys), the sameAs links added or removed.",
  },
  "w8-geo-recheck": geoRecheck(false),
  "w13-geo-recheck": geoRecheck(true),
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
