/**
 * The skill's reference files for AI search (GEO), Google Analytics and page groups. Generated from the code where a
 * number or a list lives there (crawler list, score weights, group sizes), so they cannot drift from what the tools do.
 */
import { AI_BOTS, GEO_WEIGHTS } from "./checks/geo.js";
import { AI_ENGINES, ENGINE_LABELS } from "./engine/geo.js";
import { MAX_GROUP_SIZE, MAX_SPLIT_PAGES, MIN_GROUP_SIZE, SITE_WIDE } from "./engine/chunks.js";
import { GEO_TASKS } from "./templates/geo.js";

function botTable(kind: "search" | "user" | "training"): string {
  return AI_BOTS.filter((b) => b.kind === kind)
    .map((b) => `| \`${b.token}\` | ${b.vendor} | ${b.product} |`)
    .join("\n");
}

export const GEO_DOC = `# AI search (GEO)

GEO is making a site readable and quotable by AI answer engines (ChatGPT, Claude, Perplexity, Google AI Overviews and AI Mode, Copilot, Gemini). Two different things, never mixed up in a report:

- **Readiness**: what can be verified on the site. \`geo-audit\` measures it (score 0–100).
- **Visibility**: whether assistants actually name or cite the business. Only sampled answers show it (\`record-ai-mentions\`, \`list-ai-mentions\`), and a handful of samples is a signal, not a measurement.

The plugin has no account with any AI provider and calls none of them. It never invents a result: the audit reads the site, and an answer is recorded only as you report it, with the evidence.

## The workstream (in every plan, from plan version 5)

${GEO_TASKS.map((t) => `- \`${t.templateKey}\` (week ${t.week}${t.dueDay ? `, day ${t.dueDay}` : ""}): ${t.title}`).join("\n")}
- After day 90 (compounding) the daily run opens one monthly re-check task a month (\`geo-recheck:<yyyy-mm>\`, the week-8 playbook).
- The plugin audits by itself on the first daily run, then every 4 weeks, daily while a firewall item is open, and for every snapshot older than a week. Findings are category \`geo\`; a re-run closes the ones it no longer reports.

## geo-audit: what is scored (weights, out of 100; a check that could not run is left out, not counted as a failure)

| Section | Weight | What it looks at |
|---|---|---|
| crawlers | ${GEO_WEIGHTS.crawlers} | robots.txt for each AI search crawler (24 points) and user agent (6 points), and a server probe with each bot's user agent: a firewall or CDN can refuse a bot that robots.txt allows (HTTP 403, a bot-check page). Training crawlers are not scored. |
| entity | ${GEO_WEIGHTS.entity} | Organization / LocalBusiness data on the home page: name, url, logo, description, sameAs links (3 or more), phone or email, address (not for software), a stable @id, a WebSite node tied to it. |
| answers | ${GEO_WEIGHTS.answers} | Share of sampled pages (home, the sprint's own pages, the sitemap's main pages) with a short direct answer (12 to 90 words) under at least 2 question headings, or valid FAQ markup (3 or more questions, all visible on the page). |
| brand | ${GEO_WEIGHTS.brand} | sameAs profiles that load and show the business name (7), live directory listings that show the same name and phone (8). |
| llms | ${GEO_WEIGHTS.llms} | llms.txt present and well formed. |
| snippets | ${GEO_WEIGHTS.snippets} | nosnippet, a tiny max-snippet, noai / noimageai on the home page. |

The server probe sees user-agent rules only: a block by IP range cannot be seen from here, and it says so.

## Crawlers: whose decision is it?

**Search crawlers** decide whether the site can be cited. A block by mistake (a blanket rule, an old CMS default, a rule copied from another site) is yours to fix: remove or narrow it (robots.txt is SEO scope; WordPress: \`wp-robots\`).

| Crawler | Vendor | Product |
|---|---|---|
${botTable("search")}

**User agents** open a page when a person asks the assistant about it. Blocking them is a low finding.

| Crawler | Vendor | Product |
|---|---|---|
${botTable("user")}

**Training crawlers** collect pages to train models. Blocking them does not affect Google, Bing or the crawlers above; it is the client's policy, never a defect. Report what robots.txt says. Never change a rule for them yourself; if the client never decided, put the question on Needs you once (kind message, two lines).

| Crawler | Vendor | Product |
|---|---|---|
${botTable("training")}

A **server refusal** (the probe says HTTP 403 or a bot-check page) is a firewall or CDN setting. You cannot change it. A refusal counts only when a second request repeats it next to an ordinary request that works: a burst that trips a rate limit, or a refusal that is gone the second time, is noted and not counted, and what an earlier audit found about a bot it could not judge stays open. A refused search bot raises the optional \`geo_firewall\` item on Needs you (it does not park the crawler task) with the bot names, where to look (for example Cloudflare → Security → Bots → AI Scrapers and Crawlers) and the caveat that a CDN which lets the real bots in by their own addresses turns a look-alike away: the owner may mark it done as a false alarm and it is not raised again for those bots. It is re-checked daily while open and closes itself when the bots get a normal answer. A refused training crawler never raises it and never shows as blocked AI search. The probes are sent only to the sprint's own site: \`geo-audit\` with only a \`url\` reads that site and sends no bot user agent.

## llms.txt

A proposed convention, not a standard: no major search engine or AI company has said it uses llms.txt to rank or cite a page. It is cheap and carries ${GEO_WEIGHTS.llms}% of the score; never promise a result from it. Format: \`# Business name\`, a \`> one-line summary\`, \`## Section\` headings with \`- [Page title](https://absolute-url): what it covers\`, 5 to 15 key pages that exist. A single-page app that answers every path with its home page does not have one. WordPress: only through the Connector (\`wp-verify\` files, path \`/llms.txt\`); if the Connector refuses the file name, \`skip-task\` with the reason, never Needs you.

## Entity data and sameAs

Use real facts only (\`get-client-facts\`, the site, the CRM profile). \`sameAs\` lists profiles that EXIST: LinkedIn, Facebook, Instagram, X, YouTube, Google Business Profile, Hellopeter. Wikipedia or Wikidata only when the business really has an entry; never create a page or a profile to fill the field. Extend the existing Organization node (give it an \`@id\`) rather than adding a second one; with Yoast or Rank Math use \`wp-schema\` with a stable id so it joins their graph.

## Answer blocks and FAQ markup

Under a question heading a customer would ask, put the answer first in 2 to 3 sentences (about 30 to 60 words) that stands on its own, then the detail. Facts only from the client fact sheet and the site: no invented prices, numbers or promises. FAQPage markup only for questions the page shows, word for word (Google ignores markup for hidden questions).

## Brand consistency

AI systems cross-check the site against its profiles and directory listings. Fix the site first, then list what each profile must say (name, phone, address, website, one sentence). A correction on a third-party profile needs the owner's login: prepare the text per listing and put the one grant on Needs you (kind message, copy-ready), like the directory tasks.

## Sampling AI answers (record-ai-mentions)

1. \`list-ai-mentions\` suggests questions (priority keywords, the business's own name); add the real questions customers ask (the site's FAQ, \`gsc-query\`, \`list-content\`). About 10.
2. Ask each with the answer tools you really have: a web search tool, a browser, an assistant's public page. Use only what you can run, within that tool's terms. No tool that returns an AI assistant's answer: do not guess, \`skip-task\` with that reason.
3. Record each answer: \`query\`, \`engine\` (${AI_ENGINES.map((e) => `\`${e}\` = ${ENGINE_LABELS[e]}`).join(", ")}), \`mentioned\` (the answer names the business), \`cited\` (a page of the site is listed as a source; \`citedUrls\` must include one on the site), \`evidence\` (a short quote), \`competitors\`, \`method\` (how you got it). A mention without a quote or a source URL is refused.
4. The rate counts the latest answer per question and assistant; the first sampling day stays as the baseline for the trend. Say plainly when nothing moved.

\`\`\`json
{ "sprintId": "<id>", "samples": [
  { "query": "best accountant in Durban", "engine": "search_tool", "mentioned": true, "evidence": "…Acme Accounting in Umhlanga is often recommended for…", "competitors": ["Rival & Co"], "method": "web search tool" },
  { "query": "who does VAT returns for small businesses in Durban", "engine": "search_tool", "mentioned": false, "competitors": ["Rival & Co", "Tax Hub"], "method": "web search tool" }
] }
\`\`\`

## What to avoid

- Promising a ranking or a mention in AI answers, or presenting readiness as visibility.
- llms.txt as a magic fix; "AI-optimised" keyword stuffing; FAQ markup for questions the page does not show.
- Made-up sameAs profiles, a Wikipedia or Wikidata entry for a business that has none, fake reviews.
- Recording an answer you did not get, or a mention without evidence.
- Unblocking a training crawler without the client's decision.
- Putting one client's data, names or samples in another client's sprint.
- Sending a client-visible report without the usual approval.
`;

export const ANALYTICS_DOC = `# Google Analytics (GA4), read only

The plugin reads GA4 with the same Google service account as Search Console (scope analytics.readonly, a separate token). It never writes to a property. Numbers are per ISO week (Monday first), the last 13 completed weeks on the first pull and the last 3 refreshed every morning.

## What is pulled

Per week: sessions, engaged sessions, users and key events for the whole property; the **Organic Search** channel group on its own; organic landing pages (top 25 by sessions); source / medium (top 15); key events by name; sessions that came from AI assistants (ChatGPT, Perplexity, Gemini, Copilot, Claude …). A week GA4 has no rows for is a week of zeros, not a gap. Five small reports cover the whole period.

## Connecting (connect-ga4)

\`connect-ga4\` with the sprintId (no property ID needed): it lists the properties the service account can read through the Admin API and picks the one whose web stream is the site's address; with a \`propertyId\` it uses that (a number; \`G-XXXX\` measurement IDs are refused). Then it pulls the first weeks.

**One client's analytics never go into another client's sprint.** The service account is a Viewer on every client's property, so a \`propertyId\` is checked first: one of its web streams must be this site's address, else it is refused (\`property_mismatch\`) before any number is read. Never try ids you were not given by this site's owner, and never copy another client's property id or name into a comment. Only a person connecting from the SEO page can confirm a property whose streams do not show the site (it is recorded on the integration). When no property matches, you are told only how many the service account can read; properties for other sites are never listed. The states it answers with:

| state | what it means | what happens |
|---|---|---|
| \`connected\` | pulled | grants close themselves |
| \`needs_access\` | the service account is not a Viewer on the property | Needs you item \`ga4_access\` (optional; for a client sprint it carries the email to send); retried every morning |
| \`needs_api\` | the Google Analytics Data / Admin API is not enabled for the project | Needs you item \`ga4_api\` (once for every client); retried every morning |
| \`needs_property\` | the service account reads other properties, none for this site (or several for it: those are listed) | ask the site's owner for the property ID (Admin → Property settings), then call again with \`propertyId\` |
| \`property_mismatch\` | the \`propertyId\` has no web stream for this site | nothing was read or stored; ask the owner for the right ID; a person can confirm an unusual one |
| \`bad_property\` | Google does not know that property ID | check Admin → Property settings → Property ID |
| \`no_service_account\` | no Google key yet | the service account item is on Needs you |

Carry on with other work after a state that needs a person: never ask the client in a comment, the Needs you item has the exact steps and, for a client, the email. The daily run also looks for the property by itself every few days until it finds one. The two Google Analytics grants are quiet Needs you items: they ride along on the digest and never open or reopen its issue by themselves. A one-off Google error (quota, a server blip) keeps a connected sprint connected; only a lost grant or a missing API turns it to not connected. A working connection is not knocked over by another property id being tried.

## Reading it (list-ga4-summary)

- **Organic** is GA4's Organic Search channel group. **Key events** are what the property marks as key events (enquiries, sign-ups, purchases): they are the client's definition, not yours.
- \`attribution\` splits the last four weeks' organic sessions and key events between the pages this sprint made or targets (live content, keyword targets, approved optimizations; the home page is not one of them) and every other page. \`landingCoverage\` below about 0.8 means the per-page rows undercount the long tail; the split totals stay exact because they come from the channel totals.
- \`sessionsSinceLive\` counts a page's sessions from the week it went live.
- Attribution is by landing page. It shows where visitors landed, not that the work caused them: say "landed on", not "because of".

## Using it

- Weekly review: include the organic sessions (with the change on the week before), the key events and the share that landed on the sprint's pages in the digest; \`detect-signals\` returns the same line as \`numbers\`, and the approval issue carries it.
- Day-90 report: the snapshot has \`analytics\` (last four weeks) next to the AI-search score.
- Quote only what the tool returned. GA4 revises recent days for about two days, so the last week can move a little.

## Limits

GA4 thresholds small groups, reports in the property's timezone, undercounts visitors who decline cookies where consent mode is on, and shows nothing for a site without the tag (the first pull then returns zeros: say so, and put the missing tag on Needs you if the site is ours to change).
`;

const kinds = Object.entries(SITE_WIDE)
  .map(([type, k]) => `| \`${type}\` | ${k.size} | ${k.goal.split(";")[0]!.replace(/\.$/, "")} |`)
  .join("\n");

export const PAGE_GROUPS_DOC = `# Page groups (site-wide tasks)

A task that means "every page" (a title and description for every page, alt text on every image, noindex for every private page, a canonical on every page) cannot be done well in one run on a site with hundreds of pages. The plugin splits it into **page groups**: child issues of the task's issue, each with a list of pages, opened one at a time.

| Task type | Pages per group | Goal of a group |
|---|---|---|
${kinds}

A group size you pass (\`split-task\` \`size\`) is kept between ${MIN_GROUP_SIZE} and ${MAX_GROUP_SIZE}. At most ${MAX_SPLIT_PAGES} pages are split; where many pages share a template, fix the template once and list the pages it covers.

## How it works

1. **When:** the plugin splits the task when its issue is opened (the sitemap's pages, the sprint's known pages first), when you \`start-task\` a site-wide task that has no groups, or when you call \`split-task\`. A site with no more pages than one group is not split. A "no split needed" decision is remembered for a week, except when the site's page list could not be read in full (the sitemap answered a server error): that is asked again next time.
2. **The parent** issue stays assigned to you, is not woken, and says it is split. You do not work its pages and \`complete-task\` refuses until every group is finished.
3. **A group** is a child issue with its pages, steps and definition of done, and its own branch name (\`seo/<task-key>-g<n>\` on a repo site). Work only those pages. Close the issue (mark it done) with one short comment: pages changed, what changed, the PR, commit or Connector change ids.
   Groups are worked one after the other from the work branch: an earlier group's PR may not be merged yet, so a shared template or pattern (a title pattern, a theme file) is fixed once, in the first group that meets it, and the next groups say so instead of touching it again.
4. **When a group closes** the plugin comments on the parent, opens the next group, and after the last one wakes you on the parent: check the site as a whole (the sitemap, a sample of pages across the groups) and \`complete-task\` with the totals.
5. A group you cannot do: cancel its issue with the reason. Cancelled counts as finished. A group closed by mistake and reopened is open work again.
6. **Blocked on a person** (a one-time grant, a judgement): do the pages you can, say in a comment exactly what you need and from whom, and set the group's issue to blocked. The plugin puts a line for that group on the sprint's Needs you list; the next group does not open while it is blocked. When the person marks the line done the issue comes back to you (todo, woken); if they unblock the issue themselves the line closes. The parent task is never parked or woken for it.

## Existing sprints

Nothing already open is rewritten. A task that has an issue and no groups is split only if you start it or call \`split-task\`. If the task's issue is replaced by a continuation issue (a long thread moved on), all its groups, finished ones included, move to the new issue, so it still waits for them; groups of a skipped task are cancelled.

## Do not

- Work the parent's pages in the parent's issue, or complete the parent before the last group.
- Take on a second group while one is open: the plugin opens the next one itself.
- Call \`complete-task\` on a group issue; closing it is the signal.
`;
