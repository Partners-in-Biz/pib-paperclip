import { useEffect } from "react";
import { RadioTower } from "lucide-react";
import { ActiveAgentsPanel } from "../components/ActiveAgentsPanel";
import { EmptyState } from "../components/EmptyState";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useCompany } from "../context/CompanyContext";

const DASHBOARD_LIVE_RUN_LIMIT = 50;

export function DashboardLive() {
  const { selectedCompanyId, companies } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([
      { label: "Dashboard", href: "/dashboard" },
      { label: "Live runs", backHref: "/dashboard" },
    ]);
  }, [setBreadcrumbs]);

  if (!selectedCompanyId) {
    return (
      <EmptyState
        icon={RadioTower}
        message={companies.length === 0 ? "Create an organization to view live runs." : "Select an organization to view live runs."}
      />
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-normal text-foreground">Live agent runs</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Active runs first, followed by the most recent completed runs.
          </p>
        </div>
        <div className="text-sm text-muted-foreground">Showing up to {DASHBOARD_LIVE_RUN_LIMIT}</div>
      </div>

      <ActiveAgentsPanel
        companyId={selectedCompanyId}
        title="Active / recent"
        minRunCount={DASHBOARD_LIVE_RUN_LIMIT}
        fetchLimit={DASHBOARD_LIVE_RUN_LIMIT}
        cardLimit={DASHBOARD_LIVE_RUN_LIMIT}
        emptyMessage="No active or recent agent runs."
        queryScope="dashboard-live"
        showMoreLink={false}
      />
    </div>
  );
}
