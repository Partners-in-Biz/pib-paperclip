import { CalendarClock, CheckCircle2, ExternalLink, ListChecks, NotebookPen } from "lucide-react";
import { parseChecklistItems } from "@/lib/personal-note-markdown";
import { Link } from "@/lib/router";
import { cn } from "@/lib/utils";
import type { ComponentType } from "react";
import type { CanvasNode, CanvasNodeColor, CanvasNodeKind, PersonalNote } from "@paperclipai/shared";
import { CANVAS_COLOR_THEMES } from "@/lib/planning-canvas-helpers";
import type { CanvasController } from "@/components/planning-canvas/state/useCanvasController";

function FrameNode({ node, isEditing, theme, c }: NodeRenderProps) {
  const { setNodes, setEditingNodeId } = c;

  return (
    <div className="flex items-center justify-between px-3 py-2">
      {isEditing ? (
        <input
          type="text"
          autoFocus
          value={node.title}
          onChange={(e) => {
            const val = e.target.value;
            setNodes((prev) =>
              prev.map((n) => (n.id === node.id ? { ...n, title: val } : n)),
            );
          }}
          onBlur={() => setEditingNodeId(null)}
          className="w-full bg-transparent text-xs font-bold uppercase tracking-wider outline-none"
        />
      ) : (
        <span className={cn("text-xs font-bold uppercase tracking-wider", theme.frameHeader)}>
          {node.title || "Untitled Frame"}
        </span>
      )}
      {node.handedOffIssueIdentifier ? (
        <Link
          to={`/issues/${node.handedOffIssueIdentifier}`}
          onPointerDown={(e) => e.stopPropagation()}
          className="inline-flex items-center gap-1 rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 dark:text-emerald-300"
        >
          {node.handedOffIssueIdentifier}
        </Link>
      ) : null}
    </div>
  );
}

function StickyNode({ node, isEditing, c }: NodeRenderProps) {
  const { setNodes } = c;

  return (
    <>
      {isEditing ? (
        <div className="flex h-full flex-col gap-1.5" onPointerDown={(e) => e.stopPropagation()}>
          <input
            type="text"
            autoFocus
            value={node.title}
            onChange={(e) => {
              const val = e.target.value;
              setNodes((prev) =>
                prev.map((n) => (n.id === node.id ? { ...n, title: val } : n)),
              );
            }}
            placeholder="Title…"
            className="w-full bg-transparent text-sm font-semibold outline-none"
          />
          <textarea
            value={node.content}
            onChange={(e) => {
              const val = e.target.value;
              setNodes((prev) =>
                prev.map((n) => (n.id === node.id ? { ...n, content: val } : n)),
              );
            }}
            placeholder="Write idea…"
            className="flex-1 resize-none bg-transparent text-xs leading-relaxed outline-none"
          />
        </div>
      ) : (
        <div className="flex h-full flex-col justify-between gap-2 overflow-hidden">
          <div className="space-y-1 overflow-hidden">
            {node.title ? (
              <div className="line-clamp-2 text-sm font-semibold leading-snug">
                {node.title}
              </div>
            ) : null}
            {node.content ? (
              <p className="line-clamp-4 whitespace-pre-wrap text-xs leading-relaxed opacity-85">
                {node.content}
              </p>
            ) : null}
          </div>
          {node.handedOffIssueIdentifier ? (
            <Link
              to={`/issues/${node.handedOffIssueIdentifier}`}
              onPointerDown={(e) => e.stopPropagation()}
              className="inline-flex w-fit items-center gap-1 rounded bg-background/80 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700 hover:underline dark:text-emerald-300"
            >
              <CheckCircle2 className="size-2.5" />
              {node.handedOffIssueIdentifier}
            </Link>
          ) : null}
        </div>
      )}
    </>
  );
}

function NoteNode({ node, theme, linkedNote }: NodeRenderProps) {
  const displayTitle = linkedNote?.title ?? node.title;
  const displayBody = linkedNote?.body ?? node.content;
  const checklist = parseChecklistItems(displayBody);
  const checked = checklist.filter((i) => i.checked).length;
  return (
    <div className="flex h-full flex-col justify-between">
      <div className={cn("h-1.5 w-full", theme.swatch)} />
      <div className="flex flex-1 flex-col gap-1.5 overflow-hidden p-3">
        <div className="flex items-start justify-between gap-1.5">
          <div className="flex min-w-0 items-center gap-1.5">
            <NotebookPen className="size-3.5 shrink-0 text-blue-500" />
            <span className="truncate text-sm font-semibold text-foreground">
              {displayTitle}
            </span>
          </div>
          {linkedNote ? (
            <Link
              to={`/notes/${linkedNote.id}`}
              onPointerDown={(e) => e.stopPropagation()}
              title="Open in Personal Notes"
              className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <ExternalLink className="size-3" />
            </Link>
          ) : null}
        </div>

        <p className="line-clamp-3 whitespace-pre-wrap text-xs leading-relaxed text-muted-foreground">
          {displayBody.trim() || "Empty personal note"}
        </p>

        <div className="mt-auto flex flex-wrap items-center gap-1 pt-1">
          {checklist.length > 0 ? (
            <span className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
              <ListChecks className="size-2.5" />
              {checked}/{checklist.length}
            </span>
          ) : null}
          {linkedNote?.scheduledStatus === "pending" ? (
            <span className="inline-flex items-center gap-1 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-300">
              <CalendarClock className="size-2.5" />
              Scheduled
            </span>
          ) : null}
          {(linkedNote?.handedOffIssueIdentifier ?? node.handedOffIssueIdentifier) ? (
            <Link
              to={`/issues/${linkedNote?.handedOffIssueIdentifier ?? node.handedOffIssueIdentifier}`}
              onPointerDown={(e) => e.stopPropagation()}
              className="inline-flex items-center gap-1 rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 hover:underline dark:text-emerald-300"
            >
              <CheckCircle2 className="size-2.5" />
              {linkedNote?.handedOffIssueIdentifier ?? node.handedOffIssueIdentifier}
            </Link>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function ShapeNode({ node, isEditing, c }: NodeRenderProps) {
  const { setNodes, setEditingNodeId } = c;

  return (
    isEditing ? (
      <input
        type="text"
        autoFocus
        value={node.title}
        onPointerDown={(e) => e.stopPropagation()}
        onChange={(e) => {
          const val = e.target.value;
          setNodes((prev) =>
            prev.map((n) => (n.id === node.id ? { ...n, title: val } : n)),
          );
        }}
        onBlur={() => setEditingNodeId(null)}
        className="w-full bg-transparent text-center text-sm font-semibold text-foreground outline-none"
      />
    ) : (
      <span className="text-sm font-semibold text-foreground">
        {node.title || "Shape"}
      </span>
    )
  );
}

function TextNode({ node, isEditing, c }: NodeRenderProps) {
  const { setNodes, setEditingNodeId } = c;

  return (
    isEditing ? (
      <input
        type="text"
        autoFocus
        value={node.title}
        onPointerDown={(e) => e.stopPropagation()}
        onChange={(e) => {
          const val = e.target.value;
          setNodes((prev) =>
            prev.map((n) => (n.id === node.id ? { ...n, title: val } : n)),
          );
        }}
        onBlur={() => setEditingNodeId(null)}
        className="w-full bg-transparent text-xl font-bold text-foreground outline-none"
      />
    ) : (
      <span className="text-xl font-bold tracking-tight text-foreground">
        {node.title || "Text"}
      </span>
    )
  );
}

export type NodeRenderProps = {
  node: CanvasNode;
  isEditing: boolean;
  theme: (typeof CANVAS_COLOR_THEMES)[CanvasNodeColor];
  linkedNote: PersonalNote | null | undefined;
  /** Only the stable setters: a memoized node must not render from controller state. */
  c: Pick<CanvasController, "setNodes" | "setEditingNodeId">;
};

type NodeRendererEntry = {
  /** Kind-specific classes appended to the shared node shell (selection rings come first). */
  containerClass: (node: CanvasNode, theme: NodeRenderProps["theme"]) => string;
  Render: ComponentType<NodeRenderProps>;
};

/**
 * Node-renderer registry (PAR-13933). A later ticket adds a kind by adding one entry here
 * instead of editing the page or NodeView.
 */
export const NODE_RENDERERS: Record<CanvasNodeKind, NodeRendererEntry> = {
  frame: {
    containerClass: (_node, theme) => cn("rounded-2xl border-2 border-dashed", theme.frameBg, theme.frameBorder),
    Render: FrameNode,
  },
  sticky: {
    containerClass: (_node, theme) =>
      cn("flex flex-col rounded-xl border p-3 shadow-md", theme.stickyBg, theme.stickyBorder, theme.stickyText),
    Render: StickyNode,
  },
  note: {
    containerClass: () => "flex flex-col overflow-hidden rounded-xl border border-border bg-card shadow-md",
    Render: NoteNode,
  },
  text: {
    containerClass: () => "flex items-center px-2",
    Render: TextNode,
  },
  shape: {
    containerClass: (node, theme) =>
      cn(
        "flex items-center justify-center border-2 p-3 text-center shadow-xs",
        theme.shapeBg,
        theme.shapeBorder,
        node.shape === "pill" ? "rounded-full" : node.shape === "diamond" ? "rounded-xl" : "rounded-lg",
      ),
    Render: ShapeNode,
  },
};

/** The dashed card for a kind (or an embed of a plugin) this installation cannot draw. */
export function PlaceholderCard({ kind, label }: { kind: string; label?: string }) {
  return (
    <div data-canvas-placeholder={kind} className="flex h-full items-center justify-center px-3 text-center">
      <span className="truncate text-xs font-medium text-muted-foreground">{label ?? kind}</span>
    </div>
  );
}

function PlaceholderNode({ node }: NodeRenderProps) {
  return <PlaceholderCard kind={node.kind} />;
}

/** Card for a stored kind this build does not know: it can still be moved, resized and deleted. */
const PLACEHOLDER_RENDERER: NodeRendererEntry = {
  containerClass: () => "flex flex-col overflow-hidden rounded-xl border border-dashed border-border bg-card",
  Render: PlaceholderNode,
};

/** The renderer for a node; an unknown kind gets the placeholder card instead of crashing the board. */
export function nodeRenderer(kind: string): NodeRendererEntry {
  return Object.hasOwn(NODE_RENDERERS, kind) ? NODE_RENDERERS[kind as CanvasNodeKind] : PLACEHOLDER_RENDERER;
}
