import { useQuery } from "@tanstack/react-query";
import type { PlanningCanvasIssueQuery } from "@paperclipai/shared";
import { planningCanvasesApi } from "@/api/planningCanvases";
import { queryKeys } from "@/lib/queryKeys";
import { useLatestCanvas } from "@/components/planning-canvas/nodes/canvas-context";

/**
 * The issues a kanban or timeline node reads, through the board's `POST .../query` (it applies the
 * reader's issue access, so a private issue never reaches a card). The company and board ids are
 * fixed for as long as a node is mounted, so reading them from the latest controller is safe.
 */
export function useIssueQuery(query: PlanningCanvasIssueQuery | null) {
  const c = useLatestCanvas().current;
  const companyId = c.selectedCompanyId ?? "";
  const boardId = c.activeBoard?.id ?? "";
  const queryJson = JSON.stringify(query);
  const key = queryKeys.planningCanvasQueries.run(companyId, boardId, queryJson);
  const read = useQuery({
    queryKey: key,
    queryFn: () => planningCanvasesApi.query(companyId, boardId, query!),
    enabled: !!query && !!companyId && !!boardId,
    staleTime: 15_000,
  });
  return { read, key, companyId };
}
