import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2, MessageSquareText, X } from "lucide-react";
import { MarkdownBody } from "@/components/MarkdownBody";
import { AgentPicker } from "@/components/AgentPicker";
import { Button } from "@/components/ui/button";
import { canEditBoard } from "@/components/planning-canvas/panels/related/related-source";
import { ConnectorPicker } from "@/components/planning-canvas/panels/chat/ConnectorPicker";
import { personalRefusalIn } from "@/components/planning-canvas/nodes/source-errors";
import { useBoardChat } from "@/components/planning-canvas/panels/chat/useBoardChat";
import type { CanvasController } from "@/components/planning-canvas/state/useCanvasController";
import { timeAgo } from "@/lib/timeAgo";
import { cn } from "@/lib/utils";

/**
 * Board chat (PAR-14277): pick an agent of the company, message it, read its replies and see its run.
 * The right-hand panel; under 768 px a bottom sheet so the canvas stays in view.
 */
export function ChatPanel({ c }: { c: CanvasController }) {
  const { selectedCompanyId, activeBoard, agents } = c;
  const [open, setOpen] = useState(false);
  const [agentId, setAgentId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  // Context chips (PAR-14278): keys of the nodes or the frame the ask is about.
  const [itemKeys, setItemKeys] = useState<string[]>([]);
  const [frameKey, setFrameKey] = useState<string | null>(null);
  const { chatAsk, nodeById } = c;
  useEffect(() => {
    if (!chatAsk) return;
    setOpen(true);
    setItemKeys(chatAsk.itemKeys);
    setFrameKey(chatAsk.frameKey ?? null);
  }, [chatAsk]);
  // Drop chips whose node was deleted so a send never carries a stale key.
  const liveItemKeys = itemKeys.filter((k) => nodeById.has(k));
  const liveFrameKey = frameKey && nodeById.has(frameKey) ? frameKey : null;
  const chat = useBoardChat(selectedCompanyId ?? null, activeBoard?.id, agentId, open);
  const list = useRef<HTMLDivElement>(null);
  const lastId = chat.comments[chat.comments.length - 1]?.id;
  const running = Boolean(chat.liveRun);
  // Keep the newest reply and the run line in view.
  useEffect(() => {
    const el = list.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lastId, running, open]);

  const choices = useMemo(() => agents.filter((a) => a.status !== "terminated"), [agents]);
  const agentName = useMemo(() => new Map(agents.map((a) => [a.id, a.name])), [agents]);

  if (!activeBoard) return null;
  if (!open) {
    return (
      <Button
        type="button"
        size="sm"
        variant="outline"
        aria-label="Open board chat"
        data-testid="canvas-chat-open"
        className="pointer-events-auto absolute right-3 bottom-16 z-30 bg-background shadow-md"
        onClick={() => setOpen(true)}
      >
        <MessageSquareText className="size-3.5" />
        Chat
      </Button>
    );
  }

  const writable = canEditBoard(activeBoard);
  const submit = async () => {
    if (!draft.trim()) return;
    const context = liveFrameKey ? { itemKeys: [], frameKey: liveFrameKey } : liveItemKeys.length > 0 ? { itemKeys: liveItemKeys } : undefined;
    if (await chat.send(draft, context)) {
      setDraft("");
      setItemKeys([]);
      setFrameKey(null);
    }
  };

  return (
    <aside
      aria-label="Board chat"
      data-testid="canvas-chat-panel"
      className={cn(
        "pointer-events-auto z-30 flex flex-col border-border bg-background shadow-xl",
        "absolute inset-x-0 bottom-0 max-h-1/2 border-t md:static md:max-h-none md:w-80 md:shrink-0 md:border-l md:border-t-0",
      )}
    >
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
        <div className="text-xs font-semibold text-foreground">Board chat</div>
        <Button type="button" size="icon-sm" variant="ghost" aria-label="Close board chat" onClick={() => setOpen(false)}>
          <X className="size-3.5" />
        </Button>
      </div>

      <div className="border-b border-border px-3 py-2">
        <AgentPicker
          ariaLabel="Agent"
          agents={choices}
          value={agentId}
          onChange={(id) => setAgentId(id || null)}
          placeholder="Pick an agent…"
        />
      </div>

      {writable && agentId && !chat.off && selectedCompanyId ? (
        <ConnectorPicker companyId={selectedCompanyId} boardId={activeBoard.id} agentId={agentId} sending={chat.sending} send={(body) => chat.send(body)} />
      ) : null}

      {chat.off ? (
        <p role="status" data-testid="canvas-chat-off" className="border-b border-border px-3 py-2 text-xs text-muted-foreground">
          Board chat is switched off. Nothing is sent.
        </p>
      ) : null}

      <div ref={list} className="min-h-0 flex-1 overflow-y-auto p-3">
        {!agentId ? (
          <p className="text-xs text-muted-foreground">Pick an agent to start a conversation about this board.</p>
        ) : chat.loading ? (
          <p className="text-xs text-muted-foreground">Loading…</p>
        ) : chat.loadError ? (
          <p role="alert" className="text-xs text-destructive">Could not load the conversation.</p>
        ) : chat.comments.length === 0 ? (
          <p className="text-xs text-muted-foreground">No messages yet.</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {chat.comments.map((cm) => (
              <li key={cm.id} className="min-w-0">
                <div className="flex flex-wrap items-baseline gap-x-2 text-xs">
                  <span className="min-w-0 font-medium break-all text-foreground">
                    {cm.authorAgentId ? (agentName.get(cm.authorAgentId) ?? "Agent") : cm.authorUserId === chat.userId ? "You" : "Member"}
                  </span>
                  <span className="text-muted-foreground">{timeAgo(cm.createdAt)}</span>
                </div>
                <MarkdownBody className="text-sm wrap-break-word">{cm.body}</MarkdownBody>
                {personalRefusalIn(cm.body) ? (
                  <p role="note" data-testid="canvas-chat-personal-refused" className="mt-1 text-xs text-muted-foreground">{personalRefusalIn(cm.body)}</p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {chat.liveRun ? (
          <p role="status" data-testid="canvas-chat-run" className="mt-3 flex items-center gap-1.5 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" />
            {chat.liveRun.status === "queued" ? "Waiting for the agent to start…" : "The agent is working…"}
          </p>
        ) : null}
      </div>

      {writable ? (
        <form
          className="flex flex-col gap-2 border-t border-border p-2"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          {liveItemKeys.length > 0 || liveFrameKey ? (
            <ul aria-label="Context" data-testid="canvas-chat-chips" className="flex min-w-0 flex-wrap gap-1">
              {liveFrameKey ? (
                <Chip label={`Frame: ${chipLabel(nodeById.get(liveFrameKey))}`} onRemove={() => setFrameKey(null)} />
              ) : null}
              {liveItemKeys.map((k) => (
                <Chip key={k} label={chipLabel(nodeById.get(k))} onRemove={() => setItemKeys((p) => p.filter((x) => x !== k))} />
              ))}
            </ul>
          ) : null}
          <textarea
            aria-label="Message"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            disabled={chat.off}
            placeholder={agentId ? "Message the agent" : "Pick an agent first"}
            rows={2}
            className="w-full resize-none rounded-md border border-border bg-background p-2 text-sm outline-none focus:border-ring disabled:opacity-60"
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void submit();
              }
            }}
          />
          {chat.notice && !chat.off ? (
            <p role="alert" data-testid="canvas-chat-notice" className="text-xs text-muted-foreground">{chat.notice.message}</p>
          ) : null}
          <div className="flex justify-end">
            <Button type="submit" size="sm" disabled={chat.off || !agentId || chat.sending || draft.trim().length === 0}>
              Send
            </Button>
          </div>
        </form>
      ) : (
        <p data-testid="canvas-chat-readonly" className="border-t border-border px-3 py-2 text-xs text-muted-foreground">
          You can read this chat. Sending needs edit access to the board.
        </p>
      )}
    </aside>
  );
}

function chipLabel(node: { title?: string | null; kind: string } | undefined): string {
  return node?.title?.trim() || node?.kind || "Item";
}

function Chip({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <li data-testid="canvas-chat-chip" className="flex min-w-0 max-w-full items-center gap-1 rounded-full border border-border bg-muted px-2 py-0.5 text-xs">
      <span className="min-w-0 truncate">{label}</span>
      <button type="button" aria-label={`Remove ${label}`} className="shrink-0 text-muted-foreground hover:text-foreground" onClick={onRemove}>
        <X className="size-3" />
      </button>
    </li>
  );
}
