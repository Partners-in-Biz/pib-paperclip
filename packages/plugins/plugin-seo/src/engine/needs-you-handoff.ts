/**
 * Which Needs you items the SEO Specialist can do itself ("Give to agent" on the SEO page), and what it is
 * told to do with one. Pure: the service supplies the site facts.
 *
 * Conservative on purpose: only items whose shape we know get the button. Anything about plugins, wp-admin, accounts,
 * DNS, billing, emails a person sends, or a judgement (the playbook) stays a person's, and so does a client change set
 * on a pr_only site with manual client sign-off (the person approves it there).
 */
import type { NeedsYouItem } from "./needs-you.js";

/** What kind of work the agent takes over. */
export type AgentRoute = "content" | "review" | "retry" | "theme";

export interface HandoffSite {
  siteAccess: "unlinked" | "repo" | "none" | "wordpress";
  changePolicy: "merge_seo_scope" | "pr_only" | "full";
  clientSignoff: "auto" | "manual";
  /** The WordPress Connector is connected (WordPress sprints only). */
  connectorConnected: boolean;
  /** The CRM site has an SFTP login (theme markup is the agent's then). */
  sftp: boolean;
}

/** Words that make an item a person's job whatever else it says. */
const PERSON_WORDS = /\b(plugins?|wp-admin|merchant center|dns|passwords?|log ?in|logins?|billing|domains?|hosting|host panel|purge|google ads|accounts?|invoice|payment|contract|phone|call)\b/i;
/** A change to a page's copy, meta or links. */
const CONTENT_VERB = /^(approve|apply|refresh|rewrite|write|update|publish|add)\b/i;
const CONTENT_NOUN = /\b(pages?|refresh|internal links?|meta|titles?|descriptions?|copy|faq|intro|categor(y|ies)|change set|content|body|links?)\b/i;
const CONTENT_ANYWHERE = /\b(change set|page refresh|internal links)\b/i;
/** Template markup (alt text on a theme icon, heading tags). */
const THEME_WORDS = /\b(alt|decorative|template|heading tags?|theme)\b/i;

/** Whether the agent can write this site's content itself (or through a client preview the plugin runs). */
function canWriteContent(site: HandoffSite): boolean {
  if (site.siteAccess === "repo") return true;
  if (site.siteAccess !== "wordpress" || !site.connectorConnected) return false;
  // pr_only with manual sign-off: the change set is the person's to approve, so it stays on Needs you.
  return site.changePolicy !== "pr_only" || site.clientSignoff === "auto";
}

/** The agent's route for an open item, or null when only a person can do it. */
export function agentRouteFor(item: Pick<NeedsYouItem, "key" | "kind" | "title" | "check" | "status">, site: HandoffSite): AgentRoute | null {
  if (item.status !== "open" || item.check !== "manual") return null;
  if (item.kind !== "task" && item.kind !== "review") return null;
  if (item.key.startsWith("approval-email:") || item.key.startsWith("playbook") || item.key.startsWith("apply:")) return null;
  if (item.key.startsWith("review-stalled:")) return "review";
  if (item.key.startsWith("page-skipped:")) return canWriteContent(site) ? "retry" : null;
  const title = item.title.replace(/\s+/g, " ").trim();
  if (PERSON_WORDS.test(title)) return null;
  if (THEME_WORDS.test(title)) return site.siteAccess === "wordpress" && site.connectorConnected && site.sftp ? "theme" : null;
  const content = (CONTENT_VERB.test(title) && CONTENT_NOUN.test(title)) || CONTENT_ANYWHERE.test(title);
  return content && canWriteContent(site) ? "content" : null;
}

/** What the agent is told to do with an item it was given. */
export function agentInstruction(route: AgentRoute, site: HandoffSite, sprintId: string): string {
  const stop = "If the change is already live, or another task or item covers the same page, say so in a comment and stop: do not do it twice.";
  const never = "Do not put this back on Needs you: a person gave it to you because you can do it.";
  switch (route) {
    case "content":
      if (site.siteAccess === "repo") {
        return `${stop} Make the change in the site repo on the task's branch and open a pull request (sprintId ${sprintId}).${site.changePolicy === "pr_only" ? " On this pr_only site the pull request goes on Needs you as kind pr: merging it is the one step a person takes." : " Merge it when the checks pass, then verify live."} ${never}`;
      }
      if (site.changePolicy === "pr_only") {
        return `${stop} This site's visible changes need the client's sign-off, and the plugin runs that: if the client already approved a preview of this page (list-previews), apply only that through the Connector and verify it live. Otherwise make a preview with partnersinbiz.seo:create-preview (sprintId ${sprintId}, the task's taskId, the page, a why) and end your turn: the Reviewer check, the approval email and your wake-up are automatic. Never write to the live page before the client approved it. ${never}`;
      }
      return `${stop} Apply it yourself through the Connector (the CRM's wp-* tools with the sprint's siteId from get-site-link), verify it on the live page with check-meta (sprintId ${sprintId}), then complete the task. ${never}`;
    case "review":
      return `The Reviewer did not record a verdict on this preview after repeated nudges. Read the review issue named in the item to see why (a missing tool, a crashed run). You cannot record a verdict on your own preview: if the page still needs the change, make a fresh revision with partnersinbiz.seo:create-preview (sprintId ${sprintId}) so a new review opens. If the preview is no longer needed (already applied, superseded, dropped), say so and stop. ${never}`;
    case "retry":
      return `This page was dropped from its task after failed previews. Read why with list-previews (sprintId ${sprintId}). If it can be fixed (copy you can source from the client's own pages, or markup a developer fixes through request-build), make a fresh preview with create-preview; if the honest answer is to leave the page as it is, say why in a comment and stop. ${never}`;
    case "theme":
      return `Template markup is yours on this site: follow references/wordpress.md section 11 (check-change-scope with category theme_markup, backup, php -l, upload, checksum readback, live check, rollback on any doubt). Markup only: never logic, scripts, forms or styling. ${never}`;
  }
}
