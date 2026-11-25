import { useEffect } from "react";
import { Link } from "@/lib/router";
import { Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { RESTRICTED_MEMBER_LANDING_PATH } from "../lib/member-restriction";

/**
 * The plain page a restricted member sees on a closed address (PAR-12608 4.6,
 * AC-G10). Deliberately not an error screen: nothing went wrong, the page is
 * outside his access.
 */
export function NotAvailableForAccessLevelPage() {
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([{ label: "Not available" }]);
  }, [setBreadcrumbs]);

  return (
    <div className="mx-auto max-w-2xl py-10" data-testid="member-restriction-not-available">
      <Card className="block p-6">
        <div className="flex items-start gap-3">
          <div className="rounded-md border border-border bg-muted/40 p-2">
            <Lock className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
          </div>
          <div className="min-w-0">
            <h1 className="text-xl font-semibold">Not available for your access level</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Your access in this company covers your own tasks and projects. Ask a company owner if you need this page.
            </p>
          </div>
        </div>
        <div className="mt-5 flex flex-wrap gap-2">
          <Button asChild>
            <Link to={RESTRICTED_MEMBER_LANDING_PATH}>Go to your inbox</Link>
          </Button>
        </div>
      </Card>
    </div>
  );
}
