import { useQuery } from "@tanstack/react-query";
import { Archive } from "lucide-react";
import { planningCanvasesApi, type PlanningCanvasListItem } from "@/api/planningCanvases";
import { groupBoards } from "@/components/planning-canvas/panels/sharing/sharing-helpers";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { queryKeys } from "@/lib/queryKeys";
import { OptionSelect } from "@/components/OptionSelect";

/** Board picker grouped Mine, Company and Project (plan Q16, C12). Archived boards live in `ArchivedBoards`. */
export function BoardSelect({
  boards,
  activeId,
  onSelect,
}: {
  boards: PlanningCanvasListItem[];
  activeId: string;
  onSelect: (id: string) => void;
}) {
  const groups = groupBoards(boards);
  return (
    <OptionSelect
      ariaLabel="Select canvas board"
      items={groups.flatMap((group) =>
        group.boards.map((board) => ({ value: board.id, label: board.title, group: group.label })),
      )}
      value={activeId}
      onChange={onSelect}
      placeholder="Select a board"
      className="max-w-48"
      triggerClassName="h-7 px-2 text-xs font-medium"
    />
  );
}

/** The Archived section: read-only boards, restorable by the owner or an admin from the share dialog. */
export function ArchivedBoards({
  companyId,
  onOpenShare,
}: {
  companyId: string;
  onOpenShare: (board: PlanningCanvasListItem) => void;
}) {
  const { data = [] } = useQuery({
    queryKey: queryKeys.planningCanvases.archived(companyId),
    queryFn: () => planningCanvasesApi.list(companyId, { archived: true }),
  });
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button type="button" size="xs" variant="outline" aria-label="Archived boards">
          <Archive className="size-3.5" />
          Archived ({data.length})
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="flex w-64 flex-col gap-1 p-2" data-testid="planning-canvas-archived-section">
        <div className="px-1 py-0.5 text-xs font-semibold text-muted-foreground">Archived</div>
        {data.length === 0 ? <p className="px-1 text-xs text-muted-foreground">No archived boards.</p> : null}
        {data.map((board) => (
          <button
            key={board.id}
            type="button"
            onClick={() => onOpenShare(board)}
            className="truncate rounded-md px-2 py-1.5 text-left text-xs text-foreground hover:bg-accent"
          >
            {board.title}
          </button>
        ))}
      </PopoverContent>
    </Popover>
  );
}
