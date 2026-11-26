import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Plug } from "lucide-react";
import { planningCanvasesApi } from "@/api/planningCanvases";
import { Button } from "@/components/ui/button";
import { sourceErrorMessage } from "@/components/planning-canvas/nodes/source-errors";
import { OptionSelect } from "@/components/OptionSelect";

/** The ask sent through the person's chat thread. The agent fetches with a read action and writes a node; the tool is never written to. */
export function pullAsk(tool: string): string {
  return `Fetch data with the read action "${tool}" and put the result on this board as a table node, with its source set to that action. For prose, write a markdown node and say in this chat which action you used. Use only this read action. Never write to the outside tool.`;
}

/**
 * Connector picker (PAR-14283): lists the chosen agent's read-only connector actions and asks the agent
 * to pull one onto the board. Shown only while board chat is on and the person can edit the board.
 */
export function ConnectorPicker({
  companyId,
  boardId,
  agentId,
  sending,
  send,
}: {
  companyId: string;
  boardId: string;
  agentId: string;
  sending: boolean;
  send: (body: string) => Promise<boolean>;
}) {
  const [tool, setTool] = useState("");
  const [sent, setSent] = useState(false);
  const actions = useQuery({
    queryKey: ["planning-canvas-read-actions", companyId, boardId, agentId],
    queryFn: () => planningCanvasesApi.readActions(companyId, boardId, agentId),
  });
  const list = actions.data?.actions ?? [];
  const chosen = list.find((a) => a.tool === tool);

  return (
    <section aria-label="Pull data from a connector" data-testid="canvas-connector-picker" className="flex min-w-0 flex-col gap-1.5 border-b border-border px-3 py-2">
      <div className="flex items-center gap-1.5 text-xs font-medium text-foreground">
        <Plug className="size-3.5" />
        Pull data from a connector
      </div>
      {actions.isLoading ? (
        <p className="text-xs text-muted-foreground">Loading actions…</p>
      ) : actions.error ? (
        <p role="alert" data-testid="canvas-connector-error" className="text-xs text-muted-foreground wrap-break-word">{sourceErrorMessage(actions.error)}</p>
      ) : list.length === 0 ? (
        <p data-testid="canvas-connector-empty" className="text-xs text-muted-foreground">This agent has no read actions to pull from.</p>
      ) : (
        <>
          <OptionSelect
            ariaLabel="Read action"
            items={list.map((a) => ({ value: a.tool, label: a.application ? `${a.application}: ${a.name}` : a.name, searchText: a.tool }))}
            value={tool}
            onChange={(next) => {
              setTool(next);
              setSent(false);
            }}
            emptyLabel="Pick a read action…"
            placeholder="Pick a read action…"
            className="min-w-0"
            triggerClassName="h-8 px-2 text-sm font-normal"
          />
          {chosen?.description ? <p className="text-xs text-muted-foreground wrap-break-word">{chosen.description}</p> : null}
          <div className="flex justify-end">
            <Button
              type="button"
              size="sm"
              disabled={!chosen || sending}
              onClick={async () => setSent(await send(pullAsk(chosen!.tool)))}
            >
              Pull onto board
            </Button>
          </div>
          {sent ? <p role="status" data-testid="canvas-connector-sent" className="text-xs text-muted-foreground">Asked the agent. The table appears when it finishes.</p> : null}
        </>
      )}
    </section>
  );
}
