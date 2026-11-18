import { useCallback } from "react";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { MEMBER_RESTRICTED_CODE } from "@paperclipai/shared";
import { authApi } from "../api/auth";
import { ApiError } from "../api/api-error";
import { hasUnverifiedSession } from "../lib/cached-session";
import { queryKeys } from "../lib/queryKeys";
import { memberRestrictionFor } from "../lib/member-restriction";

/**
 * A company-wide list the route table closes for a restricted member (PAR-12608
 * 4.6, AC-G10), called from a page that stays open for him: company labels and
 * external-object summaries.
 */
export interface MemberRestrictionGate {
  /**
   * True only for a person restricted in this company under `enforce`: the
   * closed list is not requested and the control that needs it hides. Under
   * `off` and `report` (where he is "a full operator", 4.2) it is false.
   * Also true while the session is still loading.
   */
  closed: boolean;
  /**
   * Wraps the closed list's fetch. A 403 `MEMBER_RESTRICTED` (a stale session:
   * the owner switched to `enforce` while the page was open) answers `empty`,
   * so no error state or toast shows, and refreshes the session so `closed`
   * catches up. Every other error is thrown as before.
   */
  guard: <T>(fetch: () => Promise<T>, empty: T) => () => Promise<T>;
}

export function isMemberRestrictedError(error: unknown): boolean {
  if (!(error instanceof ApiError) || error.status !== 403) return false;
  const body = error.body as { code?: unknown } | null;
  return body !== null && typeof body === "object" && body.code === MEMBER_RESTRICTED_CODE;
}

function refreshMemberRestriction(queryClient: QueryClient, companyId: string | null | undefined) {
  void queryClient.invalidateQueries({ queryKey: queryKeys.auth.session });
  void queryClient.invalidateQueries({ queryKey: queryKeys.access.currentBoardAccess });
  if (companyId) void queryClient.invalidateQueries({ queryKey: queryKeys.access.memberRestrictionMode(companyId) });
}

export function useMemberRestrictionGate(companyId: string | null | undefined): MemberRestrictionGate {
  const queryClient = useQueryClient();
  const { data: session, isPending, isError } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
  });
  // Held closed until the session is known, so no closed request goes out first. A session
  // restored from the saved query cache counts as unknown until the server confirms it: its
  // restriction mode may be old (PAR-12932). A failed session read opens it: the server
  // still refuses, and `guard` catches that.
  const unknown = (isPending || hasUnverifiedSession(queryClient)) && !isError;
  const closed = unknown || memberRestrictionFor(session?.memberRestrictions, companyId).enforced;
  const guard = useCallback(
    <T>(fetch: () => Promise<T>, empty: T) => async () => {
      try {
        return await fetch();
      } catch (error) {
        if (!isMemberRestrictedError(error)) throw error;
        refreshMemberRestriction(queryClient, companyId);
        return empty;
      }
    },
    [companyId, queryClient],
  );
  return { closed, guard };
}
