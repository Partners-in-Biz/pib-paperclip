import { matchPath } from "react-router-dom";
import type { MemberRestrictionMode, SessionMemberRestriction } from "@paperclipai/shared";
import { toCompanyRelativePath } from "./company-routes";

/**
 * What the screen hides for a restricted member (PAR-12608 4.6, AC-G10).
 *
 * Hiding is never the control: the server's route table refuses the same
 * pages with 403 `MEMBER_RESTRICTED`. The screen only follows it so a
 * restricted person sees no menu entry he cannot use and, on typing a closed
 * address, a plain "not available" page instead of an error screen.
 */
export interface MemberRestrictionState {
  restricted: boolean;
  mode: MemberRestrictionMode;
  /** Restricted under `enforce`: the only case in which the screen hides pages. */
  enforced: boolean;
}

export const UNRESTRICTED_MEMBER: MemberRestrictionState = { restricted: false, mode: "off", enforced: false };

/**
 * Reads the signed-in person's restriction in one company from the session
 * data. A missing entry (an older server, or no company yet) is "not
 * restricted": the server still refuses what he may not read.
 */
export function memberRestrictionFor(
  entries: readonly SessionMemberRestriction[] | null | undefined,
  companyId: string | null | undefined,
): MemberRestrictionState {
  if (!companyId) return UNRESTRICTED_MEMBER;
  const entry = entries?.find((candidate) => candidate.companyId === companyId);
  if (!entry) return UNRESTRICTED_MEMBER;
  return { restricted: entry.restricted, mode: entry.mode, enforced: entry.restricted && entry.mode === "enforce" };
}

/** Where a restricted member lands instead of the dashboard (4.6: "he lands on the inbox"). */
export const RESTRICTED_MEMBER_LANDING_PATH = "/inbox";

/** His own profile settings: the one settings page that stays open for him. */
export const RESTRICTED_MEMBER_SETTINGS_PATH = "/company/settings/instance/profile";

/**
 * The company pages that stay open for a restricted member, as
 * company-relative route patterns: the rows marked "shown" in the page table
 * of PAR-12608 4.6 (tasks, projects, inbox, search, conversations, "my
 * agents", one run on his task, approvals read-only, execution workspaces of
 * his tasks, work products, his own profile settings). Everything else is
 * closed, the same "refused unless listed" rule as the server's route table.
 * Plugin pages are decided by the plugin gate (4.8), see
 * `MemberRestrictionGate`.
 */
export const RESTRICTED_MEMBER_OPEN_PAGES: readonly string[] = [
  "/inbox",
  "/inbox/mine",
  "/inbox/recent",
  "/inbox/unread",
  "/inbox/blocked",
  "/inbox/all",
  "/inbox/new",
  "/search",
  "/issues",
  "/issues/:issueId",
  "/tasks",
  "/projects",
  "/projects/:projectId",
  "/projects/:projectId/overview",
  "/projects/:projectId/issues",
  "/projects/:projectId/issues/:filter",
  // Name, description, visibility and archive; host configuration hidden (PAR-12952).
  "/projects/:projectId/configuration",
  "/projects/:projectId/workspaces",
  "/projects/:projectId/workspaces/:workspaceId",
  "/execution-workspaces/:workspaceId",
  "/execution-workspaces/:workspaceId/issues",
  "/agents",
  "/agents/all",
  "/agents/active",
  "/agents/paused",
  "/agents/error",
  "/agents/builtin",
  "/agents/:agentId",
  "/agents/:agentId/dashboard",
  "/agents/:agentId/runs/:runId",
  "/chats",
  "/chats/:agentRef",
  "/approvals",
  "/approvals/pending",
  "/approvals/all",
  "/approvals/:approvalId",
  "/artifacts",
  "/company/settings/instance/profile",
];

/** Matches an open pattern but is a closed page (`/agents/new` is hiring). */
const RESTRICTED_MEMBER_CLOSED_EXCEPTIONS: readonly string[] = ["/agents/new"];

function normalizeRelativePath(path: string): string {
  const pathname = toCompanyRelativePath(path).split(/[?#]/)[0] ?? "/";
  return pathname.startsWith("/") ? pathname : `/${pathname}`;
}

function matchesAny(patterns: readonly string[], pathname: string): boolean {
  return patterns.some((pattern) => matchPath({ path: pattern, end: true }, pathname) !== null);
}

/** True when a company-relative page (with or without company prefix) stays open for a restricted member. */
export function isPageOpenForRestrictedMember(path: string): boolean {
  const pathname = normalizeRelativePath(path);
  if (matchesAny(RESTRICTED_MEMBER_CLOSED_EXCEPTIONS, pathname)) return false;
  return matchesAny(RESTRICTED_MEMBER_OPEN_PAGES, pathname);
}

/** True when the screen must hide a menu entry for `path` from this person. */
export function isPageHiddenForMember(state: MemberRestrictionState, path: string): boolean {
  return state.enforced && !isPageOpenForRestrictedMember(path);
}
