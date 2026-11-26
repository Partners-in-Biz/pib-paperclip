import { useRef, useState } from "react";
import { Loader2, Plug, RefreshCw } from "lucide-react";
import type { PlanningCanvasConnectorSource } from "@paperclipai/shared";
import { PLANNING_CANVAS_SOURCE_ERROR_CODES as CODES } from "@paperclipai/shared";
import { ApiError } from "@/api/client";
import { planningCanvasesApi } from "@/api/planningCanvases";
import { Button } from "@/components/ui/button";
import { useLatestCanvas } from "@/components/planning-canvas/nodes/canvas-context";
import { sourceErrorMessage } from "@/components/planning-canvas/nodes/source-errors";
import { canEditBoard } from "@/components/planning-canvas/panels/related/related-source";
import { timeAgo } from "@/lib/timeAgo";

const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();

/**
 * Where a source-bound table or doc came from: the tool, when it was fetched and by whom (PAR-14283).
 * Refresh shows only with edit access and while board chat is on (a `canvas_source_refresh_disabled`
 * answer hides it). It asks the agent through the person's chat thread; it never writes to the tool.
 */
export function SourceBadge({ nodeKey, source }: { nodeKey: string; source: Partial<PlanningCanvasConnectorSource> & { tool: string } }) {
  const latest = useLatestCanvas();
  const board = latest.current.activeBoard;
  const companyId = latest.current.selectedCompanyId;
  const [off, setOff] = useState(false);
  const [asked, setAsked] = useState(false);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const requestId = useRef<string | null>(null);
  const canRefresh = Boolean(board && companyId && canEditBoard(board)) && !off;

  const refresh = async () => {
    if (!board || !companyId || pending) return;
    setPending(true);
    setNotice(null);
    requestId.current ??= crypto.randomUUID();
    try {
      await planningCanvasesApi.refreshSource(companyId, board.id, nodeKey, requestId.current);
      requestId.current = null;
      setAsked(true);
    } catch (err) {
      if (err instanceof ApiError && err.code === CODES.refreshDisabled) setOff(true);
      setNotice(sourceErrorMessage(err));
    } finally {
      setPending(false);
    }
  };

  const fetched = source.fetchedAt ? timeAgo(source.fetchedAt) : null;
  return (
    <div data-testid="canvas-source-badge" className="flex min-w-0 flex-col gap-0.5 text-xs text-muted-foreground" onPointerDown={stop} onDoubleClick={stop}>
      <div className="flex min-w-0 items-center gap-1">
        <Plug className="size-3 shrink-0" />
        <span className="min-w-0 flex-1 truncate font-medium text-foreground" title={source.tool}>{source.tool}</span>
        {canRefresh ? (
          <Button type="button" size="xs" variant="ghost" className="shrink-0" disabled={pending} aria-label="Refresh from source" onClick={() => void refresh()}>
            {pending ? <Loader2 className="size-3 animate-spin" /> : <RefreshCw className="size-3" />}
            Refresh
          </Button>
        ) : null}
      </div>
      {fetched || source.fetchedBy ? (
        <p className="truncate" data-testid="canvas-source-meta">
          {fetched ? <>Fetched {fetched}</> : null}
          {source.fetchedBy ? <>{fetched ? " " : ""}by {source.fetchedBy}</> : null}
        </p>
      ) : null}
      {asked ? <p role="status" data-testid="canvas-source-asked">Asked the agent to fetch again.</p> : null}
      {notice ? <p role="alert" data-testid="canvas-source-notice" className="wrap-break-word">{notice}</p> : null}
    </div>
  );
}
