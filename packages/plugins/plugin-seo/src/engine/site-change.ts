/**
 * Site changes the SEO agent makes through the site's repo (or, on a
 * WordPress site, through the PiB Connector), and when it may merge or apply
 * them itself. Pure: the skill, the playbooks and `check-change-scope` all
 * read these rules.
 */

export const CHANGE_POLICIES = ["merge_seo_scope", "pr_only", "full"] as const;
export type ChangePolicy = (typeof CHANGE_POLICIES)[number];

export const HOSTINGS = ["vercel", "netlify", "other"] as const;
export type Hosting = (typeof HOSTINGS)[number];

export const SITE_ACCESS = ["unlinked", "repo", "none", "wordpress"] as const;
/**
 * unlinked: nobody said yet; repo: a Paperclip project with the repo workspace; none: no repo (CMS or client-managed);
 * wordpress: a CRM website with the PiB Connector (changes through the CRM's Connector tools).
 */
export type SiteAccess = (typeof SITE_ACCESS)[number];

/** A git ref as a branch name: `origin/development`, `refs/heads/x` and `refs/remotes/origin/x` become `development` and `x`. */
export function branchName(ref: string): string {
  return ref.trim().replace(/^refs\/remotes\/origin\//, "").replace(/^refs\/heads\//, "").replace(/^origin\//, "");
}

/**
 * The branch a project's agents work from: the base ref of its execution workspace policy
 * (`workspaceStrategy.baseRef`, e.g. `origin/development` on the dev-flow projects). Null when the project sets none
 * (it works on its default branch), or when the ref is not a branch (`HEAD`, a commit). The sprint's PR base, branch
 * point and scope diff follow it, unless a person set the branch by hand. Pure.
 */
export function workBranchFromPolicy(policy: unknown): string | null {
  const strategy = policy && typeof policy === "object" ? (policy as { workspaceStrategy?: unknown }).workspaceStrategy : null;
  const baseRef = strategy && typeof strategy === "object" ? (strategy as { baseRef?: unknown }).baseRef : null;
  if (typeof baseRef !== "string") return null;
  const branch = branchName(baseRef);
  if (!branch || branch === "HEAD" || /^[0-9a-f]{40}$/i.test(branch) || /\s/.test(branch)) return null;
  return branch;
}

/** What an agent may merge alone under `merge_seo_scope`. */
export const SEO_SCOPE: Record<string, string> = {
  head_metadata: "`<head>` metadata: title, meta description, canonical, robots meta, Open Graph / Twitter tags (Next.js `metadata` / `generateMetadata`).",
  json_ld: "JSON-LD structured data blocks (Organization, WebSite, FAQPage, Product, LocalBusiness …), including fixes such as a broken WebSite SearchAction.",
  sitemap_robots: "sitemap.xml / `app/sitemap.ts`, robots.txt / `app/robots.ts` and llms.txt. On WordPress: extra robots.txt lines (`wp-robots`) and the sitemap settings (`wp-sitemap`).",
  verification_file: "Search engine verification and key files: the google-site-verification meta tag or HTML file, the msvalidate.01 meta tag or BingSiteAuth.xml, the IndexNow key file. On WordPress with a Connector 1.2+: `wp-verify` (meta tags and root files, nothing written to disk).",
  image_alt: "Image alt text.",
  internal_links: "Internal links and their anchor text inside existing copy.",
  new_content: "New blog posts and landing pages written from an approved brief (content files or pages only; no new components beyond the page itself).",
  seo_redirect: "Redirects that fix an SEO problem (moved or duplicate URLs), in the site's redirect config. On WordPress: `wp-redirects`.",
};

export const SEO_SCOPE_CATEGORIES = Object.keys(SEO_SCOPE);

/** Files an agent never merges alone under `merge_seo_scope`, whatever it says the change is. */
const OUT_OF_SCOPE_PATHS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /(^|\/)\.env/i, reason: "environment / secrets file" },
  { pattern: /(^|\/)(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?)$/i, reason: "dependencies" },
  { pattern: /(^|\/)\.github\//i, reason: "CI workflow" },
  { pattern: /(^|\/)(vercel\.json|netlify\.toml|Dockerfile|docker-compose\.ya?ml)$/i, reason: "hosting / build config" },
  { pattern: /(^|\/)(middleware|instrumentation)\.[cm]?[jt]sx?$/i, reason: "request middleware" },
  { pattern: /(^|\/)(pages\/api|app\/api|src\/app\/api|src\/pages\/api)\//i, reason: "API route" },
  { pattern: /(^|\/)(prisma|migrations?|drizzle|supabase)\//i, reason: "database" },
  { pattern: /(^|\/)(auth|login|signin|signup|session|payments?|checkout|billing|stripe)\//i, reason: "auth / payments" },
  { pattern: /(^|\/)[^/]*(auth|login|session|payment|checkout|billing|stripe)[^/]*\.[cm]?[jt]sx?$/i, reason: "auth / payments" },
  { pattern: /(^|\/)(tsconfig|eslint|\.eslintrc|tailwind\.config|postcss\.config)[^/]*$/i, reason: "tooling config" },
];

/** next.config holds redirects; only a redirect change may touch it. */
const NEXT_CONFIG = /(^|\/)next\.config\.[cm]?[jt]s$/i;

/** Never merged by an agent under any policy. */
const NEVER_PATHS = [/(^|\/)\.env/i];

export interface ProposedChange {
  path: string;
  /** One of SEO_SCOPE_CATEGORIES, or "other". */
  category: string;
}

export type ChecksState = "passed" | "failed" | "pending";

export interface ScopeVerdict {
  decision: "merge" | "wait" | "pr_only";
  inScope: boolean;
  outOfScope: Array<{ path: string; reason: string }>;
  reasons: string[];
}

/**
 * Whether the agent may merge a PR itself. `wait` = checks are not green
 * yet (never merge on red or pending checks).
 */
export function evaluateChange(policy: ChangePolicy, changes: ProposedChange[], checks: ChecksState): ScopeVerdict {
  const outOfScope: ScopeVerdict["outOfScope"] = [];
  const reasons: string[] = [];
  if (changes.length === 0) reasons.push("No changed files were listed.");
  for (const change of changes) {
    const path = change.path.trim();
    if (NEVER_PATHS.some((p) => p.test(path))) {
      outOfScope.push({ path, reason: "secrets file: never merged by the agent" });
      continue;
    }
    if (policy === "full") continue;
    if (!SEO_SCOPE_CATEGORIES.includes(change.category)) {
      outOfScope.push({ path, reason: `category "${change.category}" is not SEO scope` });
      continue;
    }
    if (NEXT_CONFIG.test(path) && change.category !== "seo_redirect") {
      outOfScope.push({ path, reason: "next.config may only change for SEO redirects" });
      continue;
    }
    const hit = OUT_OF_SCOPE_PATHS.find((rule) => rule.pattern.test(path));
    if (hit) outOfScope.push({ path, reason: hit.reason });
  }
  const inScope = changes.length > 0 && outOfScope.length === 0;
  if (policy === "pr_only") {
    reasons.push("This sprint's change policy is pr_only: leave the PR open for a person to merge.");
    return { decision: "pr_only", inScope, outOfScope, reasons };
  }
  if (!inScope) {
    if (outOfScope.length > 0) reasons.push("Out-of-scope files: leave the PR open and add it to the Needs you digest (needs-you-add kind pr).");
    return { decision: "pr_only", inScope, outOfScope, reasons };
  }
  if (checks !== "passed") {
    reasons.push(checks === "failed" ? "Checks failed: fix the branch, never merge on red." : "Checks are still running: wait, then check again.");
    return { decision: "wait", inScope, outOfScope, reasons };
  }
  reasons.push(policy === "full" ? "Policy full and checks passed: merge." : "Every change is SEO scope and checks passed: merge (squash).");
  return { decision: "merge", inScope, outOfScope, reasons };
}

/**
 * What the PiB Connector (1.1+) applies on a WordPress site: SEO fields (title,
 * description, canonical, robots meta, Open Graph title, description and
 * image) for pages, categories and archives, schema, redirects, extra
 * robots.txt lines and sitemap settings, image alt text, featured and share
 * images (`media`), edits to existing page copy (`page_copy`, always with a
 * reason), internal links, and new pages or posts as drafts that the agent
 * publishes only when the task says so (`new_content`). Also the Connector's own
 * update, and (Connector 1.2+) search engine verification tags and key files through
 * `wp-verify` (`verification_file`). `page_copy` and `media` exist only on WordPress; repo sites keep
 * SEO_SCOPE_CATEGORIES.
 */
export const WORDPRESS_SCOPE_CATEGORIES = [
  "head_metadata",
  "json_ld",
  "seo_redirect",
  "sitemap_robots",
  "image_alt",
  "internal_links",
  "new_content",
  "page_copy",
  "media",
  // Markup in a theme or plugin template file over SFTP (alt attributes, meta/link/heading tags, no logic): needs the site's SFTP login.
  "theme_markup",
  // Connector 1.2+ only (wp-verify): applicable when the site's Connector has it, see evaluateWordPressChange.
  "verification_file",
];

/**
 * Always a person, whatever the policy: plugin installs and rollbacks, deleting anything, publishing anything the
 * Connector did not create, changing the theme or a site's settings. The Connector refuses most of these anyway.
 */
const WP_PERSON_ONLY: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /^wp:plugins?\b/i, reason: "plugin installs and rollbacks always go to a person (Needs you)" },
  { pattern: /^wp:(delete|trash|remove)\b/i, reason: "deleting anything is for a person in wp-admin (the Connector cannot delete)" },
  { pattern: /^wp:publish-existing\b/i, reason: "publishing anything the Connector did not create is for a person (the Connector refuses it)" },
  { pattern: /^wp:(settings|options|users?)\b/i, reason: "a site's settings and users are for a person in wp-admin" },
  { pattern: /^wp:theme\b/i, reason: "theme changes go to a person unless they are template markup edits over SFTP (category theme_markup)" },
];

export interface WordPressVerdict {
  /** apply = make the change yourself through the Connector tools, then verify it live. */
  decision: "apply" | "pr_only";
  verdict: "apply" | "pr_only";
  siteAccess: "wordpress";
  inScope: boolean;
  outOfScope: Array<{ path: string; reason: string }>;
  reasons: string[];
}

/**
 * Whether the agent may apply a change set on a WordPress site itself. Paths
 * name the Connector area and target, e.g. `wp:seo:/about`,
 * `wp:schema:site/localbusiness`, `wp:redirects:/old-page`.
 */
export function evaluateWordPressChange(policy: ChangePolicy, changes: ProposedChange[], opts: { verify?: "available" | "update" | "none"; sftp?: boolean } = {}): WordPressVerdict {
  const verify = opts.verify ?? "available";
  const sftp = opts.sftp ?? false;
  const outOfScope: WordPressVerdict["outOfScope"] = [];
  const reasons: string[] = [];
  if (changes.length === 0) reasons.push("No changes were listed.");
  for (const change of changes) {
    const path = change.path.trim();
    const personOnly = change.category === "plugins" ? WP_PERSON_ONLY[0] : WP_PERSON_ONLY.find((rule) => rule.pattern.test(path) && !(change.category === "theme_markup" && /^wp:theme\b/i.test(path)));
    if (personOnly) {
      outOfScope.push({ path, reason: personOnly.reason });
      continue;
    }
    if (change.category === "theme_markup" && !sftp) {
      outOfScope.push({
        path,
        reason: "theme_markup edits a template file over SFTP and this site has no SFTP login yet: put `needs-you-add` key `wp_sftp` on Needs you (a person adds the login once), then block-task",
      });
      continue;
    }
    if (change.category === "verification_file" && verify !== "available") {
      outOfScope.push({
        path,
        reason:
          verify === "update"
            ? "verification_file needs Connector 1.2 (wp-verify) and this site runs an older Connector: run `partnersinbiz.crm:wp-connector` update first (a Connector older than 1.1 needs one manual zip upload), then check again"
            : "verification_file goes through wp-verify, which needs a connected Connector 1.2 or newer",
      });
      continue;
    }
    if (!WORDPRESS_SCOPE_CATEGORIES.includes(change.category)) {
      outOfScope.push({ path, reason: `category "${change.category}" is not something the Connector applies (only ${WORDPRESS_SCOPE_CATEGORIES.join(", ")}). If it needs an image you have no source for, ask for the asset, not for a wp-admin edit` });
    }
  }
  const inScope = changes.length > 0 && outOfScope.length === 0;
  const done = (decision: WordPressVerdict["decision"]): WordPressVerdict => ({ decision, verdict: decision, siteAccess: "wordpress", inScope, outOfScope, reasons });
  if (policy === "pr_only") {
    reasons.push("This sprint's change policy is pr_only: write the exact change set (page, field, old value, new value), put it on Needs you (needs-you-add kind task, the change set in copy) and block-task.");
    return done("pr_only");
  }
  if (!inScope) {
    if (outOfScope.length > 0) reasons.push("Out of scope for the Connector: put the exact change set on Needs you (needs-you-add kind task) and block-task.");
    return done("pr_only");
  }
  reasons.push("Every change is in the Connector's scope: apply it with the Connector tools (siteId and a reason on every write), then verify it on the live site. New pages stay drafts until the task says to publish them.");
  return done("apply");
}

/**
 * Task types whose work changes the site's code or content. Their issues
 * live in the linked site project so the agent works in the repo workspace.
 */
export const CODE_TASK_TYPES = new Set([
  "meta-tag-audit",
  "schema-add",
  "robots-check",
  "canonical-check",
  "alt-text-audit",
  "noindex-add",
  "internal-link-add",
  "page-write",
  "page-rewrite",
  "post-publish",
  "pillar-publish",
  "pseo-feature",
  "pseo-comparison",
  "cluster-publish",
  "gsc-verify",
  "bing-verify",
  "gsc-request-index",
  "cross-link",
  "cwv-check",
  "cwv-audit",
  "retarget",
  "code-fix",
  "site-fix",
  "schema-fix",
  // Local service, professional services and online shop plans (templates/plans.ts).
  "nap-fix",
  "reviews-display",
  "area-pages",
  "collection-pages",
  // The GEO (AI search) workstream's site changes (templates/geo.ts GEO_CODE_TYPES; tests keep them equal).
  "geo-crawler-access",
  "geo-llms-txt",
  "geo-entity-schema",
  "geo-answer-blocks",
]);

const CODE_WORDS = /\b(schema|json-?ld|searchaction|meta ?tags?|title tag|canonical|noindex|robots\.txt|sitemap|alt text|redirect|structured data|og:image|open graph|fix)\b/i;

/** Code task by type, or a manual task whose title reads like a site fix (e.g. "Fix broken WebSite SearchAction"). */
export function isCodeTask(task: { taskType: string; title?: string; source?: string }): boolean {
  if (CODE_TASK_TYPES.has(task.taskType)) return true;
  return task.source === "manual" && task.taskType === "custom" && CODE_WORDS.test(task.title ?? "");
}

/** Git branch for a task: `seo/<task-key>`. */
export function branchFor(task: { templateKey: string | null; id: string; title: string }): string {
  const base = task.templateKey ?? `${task.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40)}-${task.id.slice(0, 6)}`;
  return `seo/${base}`;
}

/** `https://github.com/<owner>/<repo>(.git)` → owner/repo, else null. */
export function githubRepo(repoUrl: string | null | undefined): { owner: string; repo: string } | null {
  if (!repoUrl) return null;
  const match = /github\.com[:/]([^/\s]+)\/([^/\s#?]+?)(?:\.git)?\/?$/i.exec(repoUrl.trim());
  return match ? { owner: match[1]!, repo: match[2]! } : null;
}
