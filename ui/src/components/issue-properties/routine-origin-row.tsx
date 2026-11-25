import { useQuery } from "@tanstack/react-query";
import { Repeat } from "lucide-react";
import { Link } from "@/lib/router";
import { badgeVariants } from "@/components/ui/badge";
import { routinesApi } from "../../api/routines";
import { useMemberRestrictionGate } from "../../hooks/useMemberRestrictionGate";
import { queryKeys } from "../../lib/queryKeys";
import { cn } from "../../lib/utils";
import { PropertyRow } from "./primitives";

export function RoutineOriginRow({ routineId, companyId }: { routineId: string; companyId: string }) {
  // Routines are closed to a restricted member under `enforce` (AC-G10): the row is left out.
  const memberGate = useMemberRestrictionGate(companyId);
  const { data: routine } = useQuery({
    queryKey: queryKeys.routines.detail(routineId),
    queryFn: memberGate.guard(() => routinesApi.get(routineId), null),
    enabled: !memberGate.closed,
  });

  const title = routine?.title?.trim();
  if (memberGate.closed || !title) return null;

  return (
    <PropertyRow label="Routine">
      <Link
        to={`/routines/${routineId}`}
        className={cn(
          badgeVariants({ variant: "outline" }),
          "min-w-0 max-w-full shrink font-normal no-underline hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-(length:--rad-3) focus-visible:ring-ring",
        )}
        title={title}
      >
        <Repeat className="h-3 w-3 shrink-0" aria-hidden />
        <span className="min-w-0 truncate">{title}</span>
      </Link>
    </PropertyRow>
  );
}
