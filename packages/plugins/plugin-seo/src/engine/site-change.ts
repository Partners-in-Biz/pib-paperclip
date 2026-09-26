/**
 * Site changes the SEO agent makes through the site's repo, and when it may
 * merge them itself. Pure: the skill, the playbooks and `check-change-scope`
 * all read these rules.
 */

export const CHANGE_POLICIES = ["merge_seo_scope", "pr_only", "full"] as const;
export type ChangePolicy = (typeof CHANGE_POLICIES)[number];

export const HOSTINGS = ["vercel", "netlify", "other"] as const;
export type Hosting = (typeof HOSTINGS)[number];

export const SITE_ACCESS = ["unlinked", "repo", "none"] as const;
/** unlinked: nobody said yet; repo: a Paperclip project with the repo workspace; none: no repo (CMS or client-managed). */
export type SiteAccess = (typeof SITE_ACCESS)[number];

/** What an agent may merge alone under `merge_seo_scope`. */
export const SEO_SCOPE: Record<string, string> = {
  head_metadata: "`<head>` metadata: title, meta description, canonical, robots meta, Open Graph / Twitter tags (Next.js `metadata` / `generateMetadata`).",
  json_ld: "JSON-LD structured data blocks (Organization, WebSite, FAQPage, Product, LocalBusiness …), including fixes such as a broken WebSite SearchAction.",
  sitemap_robots: "sitemap.xml / `app/sitemap.ts` and robots.txt / `app/robots.ts`.",
  verification_file: "Search engine verification and key files: the google-site-verification meta tag or HTML file, BingSiteAuth.xml, the IndexNow key file.",
  image_alt: "Image alt text.",
  internal_links: "Internal links and their anchor text inside existing copy.",
  new_content: "New blog posts and landing pages written from an approved brief (content files or pages only; no new components beyond the page itself).",
  seo_redirect: "Redirects that fix an SEO problem (moved or duplicate URLs), in the site's redirect config.",
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
