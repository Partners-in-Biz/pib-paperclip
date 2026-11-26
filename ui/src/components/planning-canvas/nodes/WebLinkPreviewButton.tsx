import { useContext, useRef, useState } from "react";
import { Loader2, Sparkles } from "lucide-react";
import { PLANNING_CANVAS_UNFURL_ERROR_CODES as CODES, type PlanningCanvasWebLinkData } from "@paperclipai/shared";
import { ApiError } from "@/api/client";
import { planningCanvasesApi } from "@/api/planningCanvases";
import { Button } from "@/components/ui/button";
import { CanvasRefContext } from "@/components/planning-canvas/nodes/canvas-context";
import { canEditBoard } from "@/components/planning-canvas/panels/related/related-source";

const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();

/** The refusal code: the server sends it as `body.code` (`body.error` is the message). */
function unfurlErrorCode(err: unknown): string | null {
  if (!(err instanceof ApiError)) return null;
  const bodyCode = (err.body as { code?: unknown } | null)?.code;
  return typeof bodyCode === "string" ? bodyCode : err.code;
}

function unfurlErrorMessage(code: string | null): string {
  if (code === CODES.disabled) return "Link previews are switched off.";
  if (code === CODES.rateLimited) return "Too many previews this hour. Try again later.";
  if (code === CODES.busy) return "Previews are busy. Try again in a moment.";
  return "Could not get a preview.";
}

/**
 * "Get preview" on a web link card (PAR-14389 C.5, D3). Offered with edit access only, and only
 * on a board (outside the canvas there is no controller, so nothing is offered). The server
 * fetches only on the click and reads the URL from the stored node; the answer is saved on the
 * node through the ops route like any other edit. A `canvas_unfurl_disabled` answer hides it.
 */
export function useWebLinkPreview(nodeKey: string | undefined, data: PlanningCanvasWebLinkData) {
  const latest = useContext(CanvasRefContext);
  const board = latest?.current.activeBoard;
  const companyId = latest?.current.selectedCompanyId;
  const [off, setOff] = useState(false);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const current = useRef(data);
  current.current = data;
  const canFetch = Boolean(nodeKey && board && companyId && canEditBoard(board)) && !off;

  const getPreview = async () => {
    if (!latest || !nodeKey || !board || !companyId || pending) return;
    const url = data.url;
    setPending(true);
    setNotice(null);
    try {
      const { preview } = await planningCanvasesApi.unfurl(companyId, board.id, nodeKey);
      if (!preview) setNotice("No preview for this link.");
      // The card's link changed while the server fetched: the answer belongs to the old one.
      else if (current.current.url !== url) setNotice("The link changed. Try again.");
      else latest.current.opStore.setNodeData(nodeKey, { url, preview });
    } catch (err) {
      const code = unfurlErrorCode(err);
      if (code === CODES.disabled) setOff(true);
      setNotice(unfurlErrorMessage(code));
    } finally {
      setPending(false);
    }
  };
  return { canFetch, pending, notice, getPreview };
}

export function WebLinkPreviewButton({ pending, onClick }: { pending: boolean; onClick: () => void }) {
  return (
    <Button
      type="button"
      size="xs"
      variant="ghost"
      className="shrink-0"
      disabled={pending}
      onPointerDown={stop}
      onDoubleClick={stop}
      onClick={onClick}
    >
      {pending ? <Loader2 className="size-3 animate-spin" /> : <Sparkles className="size-3" />}
      Get preview
    </Button>
  );
}
