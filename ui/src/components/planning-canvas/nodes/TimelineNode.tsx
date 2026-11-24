import { memo, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { CalendarRange, Flag, RefreshCw } from "lucide-react";
import type { PlanningCanvasTimelineData } from "@paperclipai/shared";
import { projectsApi } from "@/api/projects";
import { Button } from "@/components/ui/button";
import { queryKeys } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import { useLatestCanvas } from "@/components/planning-canvas/nodes/canvas-context";
import { RefCard } from "@/components/planning-canvas/nodes/RefCard";
import { useIssueQuery } from "@/components/planning-canvas/nodes/useIssueQuery";
import {
  isCapped,
  issueBars,
  projectBars,
  projectMilestones,
  timelineLayout,
  type TimelineBar,
  type TimelineScale,
} from "@/components/planning-canvas/nodes/issue-board";

const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();
const SCALES: TimelineScale[] = ["day", "week", "month"];
const ROW = "h-5";

/**
 * A timeline node. An issue bar runs from `startedAt` (or `createdAt`) to `completedAt` (or now);
 * a project's `targetDate` is a milestone flag. There is no due-date column and no date dragging.
 * Only `scale` is saved to the board, as a field-level merge of the node's own data.
 */
export const TimelineNode = memo(function TimelineNode({ nodeKey, data, title }: { nodeKey: string; data: PlanningCanvasTimelineData; title: string }) {
  const latest = useLatestCanvas();
  const projectsSource = data.source.kind === "projects";
  const { read } = useIssueQuery(data.source.kind === "issues" ? data.source : null);
  const companyId = latest.current.selectedCompanyId ?? "";
  const projects = useQuery({
    queryKey: queryKeys.projects.list(companyId),
    queryFn: () => projectsApi.list(companyId),
    enabled: !!companyId,
    staleTime: 30_000,
  });

  const issues = read.data?.issues;
  const model = useMemo(() => {
    const now = Date.now();
    const list = projects.data ?? [];
    if (data.source.kind === "projects") {
      return { bars: projectBars(list, now), milestones: projectMilestones(list, null), now };
    }
    const only = data.source.filter.projectId ? new Set([data.source.filter.projectId]) : new Set((issues ?? []).flatMap((i) => (i.projectId ? [i.projectId] : [])));
    return { bars: issueBars(issues ?? [], now), milestones: projectMilestones(list, only), now };
  }, [data.source, issues, projects.data]);
  const layout = useMemo(() => timelineLayout(model.bars, model.milestones, data.scale, model.now, data.range), [model, data.scale, data.range]);

  const loading = projectsSource ? projects.isPending : !issues && !read.isError;
  const failed = projectsSource ? projects.isError : read.isError;
  const retry = () => void (projectsSource ? projects.refetch() : read.refetch());
  const empty = !loading && !failed && model.bars.length === 0 && model.milestones.length === 0;
  const capped = !projectsSource && issues && data.source.kind === "issues" && isCapped(issues.length, data.source);

  let body;
  if (failed) {
    body = (
      <div role="alert" className="flex flex-col items-start gap-1 text-xs text-destructive">
        <span>Couldn't load the timeline.</span>
        <Button type="button" size="xs" variant="outline" onClick={retry}>
          <RefreshCw className="size-3" /> Retry
        </Button>
      </div>
    );
  } else if (loading) {
    body = <p className="text-xs text-muted-foreground">Loading timeline…</p>;
  } else if (empty) {
    body = <p className="text-xs text-muted-foreground">Nothing to show on the timeline yet.</p>;
  } else {
    body = (
      <div className="min-h-0 flex-1 overflow-auto" onMouseDown={stop} onWheel={stop}>
        <div className="relative flex flex-col gap-0.5" style={{ width: `${layout.widthRem}rem` }}>
          <div className={cn("relative border-b border-border", ROW)} aria-hidden>
            {layout.ticks.map((tick) => (
              <span key={tick.at} className="absolute top-0 -translate-x-1/2 whitespace-nowrap text-xs text-muted-foreground" style={{ left: `${tick.pct}%` }}>
                {tick.label}
              </span>
            ))}
          </div>
          {model.milestones.length > 0 ? (
            <div className={cn("relative", ROW)}>
              {model.milestones.map((m) => (
                <span key={m.id} title={`${m.label}: target ${new Date(m.at).toLocaleDateString()}`} className="absolute top-0 flex -translate-x-1/2 items-center gap-0.5 text-xs text-amber-700 dark:text-amber-300" style={{ left: `${layout.pct(m.at)}%` }}>
                  <Flag className="size-3 shrink-0" />
                  <span className="max-w-24 truncate">{m.label}</span>
                </span>
              ))}
            </div>
          ) : null}
          {model.bars.map((bar: TimelineBar) => {
            const left = layout.pct(bar.start);
            const width = Math.max(layout.pct(bar.end) - left, 0.5);
            return (
              <div key={bar.id} className={cn("relative", ROW)}>
                <div
                  title={bar.label}
                  className={cn("absolute top-0.5 bottom-0.5 truncate rounded px-1 text-xs leading-4", bar.done ? "bg-emerald-500/30 text-foreground" : "bg-blue-500/30 text-foreground")}
                  style={{ left: `${left}%`, width: `${width}%` }}
                >
                  {bar.label}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <RefCard label={title || "Timeline"} icon={<CalendarRange className="size-3.5" />}>
      <div className="flex items-center gap-1" onMouseDown={stop} onDoubleClick={stop}>
        <div role="group" aria-label="Scale" className="flex rounded border border-border">
          {SCALES.map((scale) => (
            <button
              key={scale}
              type="button"
              aria-pressed={data.scale === scale}
              className={cn("px-1.5 py-0.5 text-xs capitalize", data.scale === scale ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground")}
              onClick={() => data.scale !== scale && latest.current.opStore.setNodeData(nodeKey, { ...data, scale })}
            >
              {scale}
            </button>
          ))}
        </div>
        <span className="ml-auto text-xs text-muted-foreground">{model.bars.length} {projectsSource ? "projects" : "issues"}</span>
      </div>
      {capped ? (
        <p role="status" className="text-xs text-amber-700 dark:text-amber-300">
          Showing the first {issues!.length} issues. Narrow the query to see the rest.
        </p>
      ) : null}
      {body}
    </RefCard>
  );
});
