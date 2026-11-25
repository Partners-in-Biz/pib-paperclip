import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Navigate, Outlet, useLocation, useNavigationType, useParams } from "@/lib/router";
import { pluginsApi } from "../api/plugins";
import { queryKeys } from "../lib/queryKeys";
import { useMemberRestriction } from "../context/MemberRestrictionContext";
import { isPageOpenForRestrictedMember, RESTRICTED_MEMBER_LANDING_PATH } from "../lib/member-restriction";
import { NotAvailableForAccessLevelPage } from "../pages/NotAvailableForAccessLevel";
import { PaperclipLoading } from "./AnimatedPaperclipIcon";

function companyRelativeSegments(pathname: string, companyPrefix: string | undefined): string[] {
  const segments = pathname.split("/").filter(Boolean);
  if (companyPrefix && segments[0]?.toUpperCase() === companyPrefix.toUpperCase()) return segments.slice(1);
  return segments;
}

/**
 * Layout route around every company page (PAR-12608 4.6, AC-G10). For a
 * person restricted under `enforce` in the route's company, a page that is
 * not on the open list renders the plain "not available" page instead of the
 * page itself. Plugin pages pass when the plugin is in `ui-contributions`,
 * which the server already filters by the plugin gate (4.8).
 */
export function MemberRestrictionGate() {
  const { enforced, loading } = useMemberRestriction();
  const location = useLocation();
  const navigationType = useNavigationType();
  const { companyPrefix } = useParams<{ companyPrefix?: string }>();
  const segments = useMemo(
    () => companyRelativeSegments(location.pathname, companyPrefix),
    [companyPrefix, location.pathname],
  );
  const relativePath = `/${segments.join("/")}`;
  const open = isPageOpenForRestrictedMember(relativePath);
  const mayBePluginPage = enforced && !open && segments.length > 0;
  const { data: contributions, isLoading: contributionsLoading } = useQuery({
    queryKey: queryKeys.plugins.uiContributions,
    queryFn: () => pluginsApi.listUiContributions(),
    enabled: mayBePluginPage,
  });

  if (loading) return <PaperclipLoading />;
  if (!enforced || open) return <Outlet />;

  // He lands on the inbox: the company root, and the dashboard when an app
  // link sends him there (a company switch). Typing the dashboard address is a
  // page load (`POP`) and gets the "not available" page like any closed page.
  if (segments.length === 0 || (relativePath === "/dashboard" && navigationType !== "POP")) {
    return <Navigate to={RESTRICTED_MEMBER_LANDING_PATH} replace />;
  }

  if (contributionsLoading) return <PaperclipLoading />;
  const [first, second] = segments.map((segment) => segment.toLowerCase());
  const pluginPageOpen = (contributions ?? []).some((contribution) =>
    first === "plugins"
      ? contribution.pluginId.toLowerCase() === second
      : contribution.slots.some((slot) => slot.type === "page" && slot.routePath?.toLowerCase() === first),
  );
  return pluginPageOpen ? <Outlet /> : <NotAvailableForAccessLevelPage />;
}
