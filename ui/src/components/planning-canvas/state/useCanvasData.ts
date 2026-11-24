// PAR-13933: moved verbatim from pages/PlanningCanvas.tsx; no behaviour change.
import { useEffect, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type PersonalNote } from "@paperclipai/shared";
import { agentsApi } from "@/api/agents";
import { personalNotesApi } from "@/api/personalNotes";
import { planningCanvasesApi } from "@/api/planningCanvases";
import { projectsApi } from "@/api/projects";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompany } from "@/context/CompanyContext";
import { useDialogActions } from "@/context/DialogContext";
import { useToastActions } from "@/context/ToastContext";
import { queryKeys } from "@/lib/queryKeys";

export function useCanvasData() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { openNewIssue } = useDialogActions();
  const { pushToast } = useToastActions();
  const queryClient = useQueryClient();

  useEffect(() => {
    setBreadcrumbs([{ label: "Planning Canvas" }]);
  }, [setBreadcrumbs]);

  const { data: boards = [], isLoading: boardsLoading } = useQuery({
    queryKey: queryKeys.planningCanvases.list(selectedCompanyId!),
    queryFn: () => planningCanvasesApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: personalNotes = [] } = useQuery({
    queryKey: queryKeys.personalNotes.list(selectedCompanyId!),
    queryFn: () => personalNotesApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: agents = [] } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: projects = [] } = useQuery({
    queryKey: queryKeys.projects.list(selectedCompanyId!),
    queryFn: () => projectsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const notesById = useMemo(
    () => new Map<string, PersonalNote>(personalNotes.map((n) => [n.id, n])),
    [personalNotes],
  );

  return {
    selectedCompanyId,
    openNewIssue,
    pushToast,
    queryClient,
    boards,
    boardsLoading,
    personalNotes,
    agents,
    projects,
    notesById,
  };
}

export type CanvasData = ReturnType<typeof useCanvasData>;
