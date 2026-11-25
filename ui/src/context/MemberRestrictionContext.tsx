import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { authApi } from "../api/auth";
import { queryKeys } from "../lib/queryKeys";
import { useParams } from "@/lib/router";
import { useCompany } from "./CompanyContext";
import {
  isPageHiddenForMember,
  memberRestrictionFor,
  UNRESTRICTED_MEMBER,
  type MemberRestrictionState,
} from "../lib/member-restriction";

export interface MemberRestrictionContextValue extends MemberRestrictionState {
  /** The session data is still loading; the gate waits instead of rendering a page it may close. */
  loading: boolean;
  /** True when the screen hides a menu entry for this company-relative path. */
  isPageHidden: (path: string) => boolean;
}

const UNRESTRICTED_CONTEXT: MemberRestrictionContextValue = {
  ...UNRESTRICTED_MEMBER,
  loading: false,
  isPageHidden: () => false,
};

const MemberRestrictionContext = createContext<MemberRestrictionContextValue>(UNRESTRICTED_CONTEXT);

/**
 * Provides the signed-in person's restriction in the company of the current
 * route (session data `memberRestrictions`, PAR-12608 4.2). Mounted around the
 * company layout; outside it every consumer sees "not restricted".
 */
export function MemberRestrictionProvider({ children }: { children: ReactNode }) {
  const { companyPrefix } = useParams<{ companyPrefix?: string }>();
  const { companies, selectedCompanyId } = useCompany();
  const { data: session, isLoading } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
  });
  const routeCompanyId = useMemo(() => {
    if (!companyPrefix) return selectedCompanyId;
    const requested = companyPrefix.toUpperCase();
    return companies.find((company) => company.issuePrefix.toUpperCase() === requested)?.id ?? selectedCompanyId;
  }, [companies, companyPrefix, selectedCompanyId]);

  const value = useMemo<MemberRestrictionContextValue>(() => {
    const state = memberRestrictionFor(session?.memberRestrictions, routeCompanyId);
    return { ...state, loading: isLoading, isPageHidden: (path) => isPageHiddenForMember(state, path) };
  }, [isLoading, routeCompanyId, session?.memberRestrictions]);

  return <MemberRestrictionContext.Provider value={value}>{children}</MemberRestrictionContext.Provider>;
}

/** The signed-in person's restriction in the current company, for menus and pages that hide closed entries. */
export function useMemberRestriction(): MemberRestrictionContextValue {
  return useContext(MemberRestrictionContext);
}
