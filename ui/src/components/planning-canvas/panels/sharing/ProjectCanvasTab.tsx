import { useQuery } from "@tanstack/react-query";
import { planningCanvasesApi } from "@/api/planningCanvases";
import { MEMBER_ACCESS_LABEL } from "@/components/planning-canvas/panels/sharing/sharing-helpers";
import { Link } from "@/lib/router";
import { queryKeys } from "@/lib/queryKeys";

/** Canvas tab of a project: boards shared with this project that the caller can open. */
export function ProjectCanvasTab({ companyId, projectId }: { companyId: string; projectId: string }) {
  const { data, isLoading, error } = useQuery({
    queryKey: queryKeys.planningCanvases.project(companyId, projectId),
    queryFn: () => planningCanvasesApi.list(companyId, { scope: "project", projectId }),
  });
  if (isLoading) return <p className="text-sm text-muted-foreground">Loading boards…</p>;
  if (error) return <p role="alert" className="text-sm text-destructive">Could not load this project's boards.</p>;
  const boards = data ?? [];
  return (
    <section aria-label="Project canvas boards" data-testid="project-canvas-tab" className="flex flex-col gap-2">
      {boards.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No board is shared with this project yet. Open a board in the Planning Canvas and share it with a project.
        </p>
      ) : null}
      <ul className="flex flex-col gap-1.5">
        {boards.map((board) => (
          <li key={board.id}>
            <Link
              to={`/planning-canvas?board=${board.id}`}
              className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2 text-sm hover:bg-accent/40"
            >
              <span className="min-w-0 truncate font-medium text-foreground">{board.title}</span>
              <span className="shrink-0 text-xs text-muted-foreground">{board.memberAccess ? MEMBER_ACCESS_LABEL[board.memberAccess] : ""}</span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
