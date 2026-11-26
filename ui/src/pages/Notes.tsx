import { OptionSelect } from "@/components/OptionSelect";
import { AgentPicker } from "@/components/AgentPicker";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  PERSONAL_NOTE_COLORS,
  type Agent,
  type CanvasNodeColor,
  type PersonalNote,
  type PersonalNoteColor,
  type PersonalNoteLinkedTask,
  type PersonalNoteRecurrence,
  type Project,
} from "@paperclipai/shared";
import {
  AlertTriangle,
  Archive,
  ArchiveRestore,
  ArrowUpRight,
  CalendarClock,
  CalendarDays,
  Check,
  CheckCircle2,
  CheckSquare,
  Clock,
  ExternalLink,
  Eye,
  FolderOpen,
  LayoutGrid,
  Link2,
  ListChecks,
  Mic,
  MicOff,
  NotebookPen,
  PanelLeft,
  Pencil,
  Pin,
  Plus,
  Repeat,
  Search,
  Send,
  Sparkles,
  Split,
  Square,
  Tag,
  Trash2,
  Undo2,
  Wand2,
  X,
} from "lucide-react";
import { Link, useNavigate, useParams } from "@/lib/router";
import { useCompany } from "@/context/CompanyContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useDialogActions } from "@/context/DialogContext";
import { useToastActions } from "@/context/ToastContext";
import { personalNotesApi } from "@/api/personalNotes";
import { planningCanvasesApi } from "@/api/planningCanvases";
import { agentsApi } from "@/api/agents";
import { projectsApi } from "@/api/projects";
import { queryKeys } from "@/lib/queryKeys";
import { NOTE_COLOR_STYLES } from "@/lib/personal-note-colors";
import { createCanvasId } from "@/lib/planning-canvas-helpers";
import {
  extractWikiLinks,
  findBacklinks,
  formatNoteAsAgentBrief,
  NOTE_SLASH_COMMANDS,
  parseChecklistItems,
  PERSONAL_NOTE_TEMPLATES,
  toggleChecklistLine,
  type NoteSlashCommand,
} from "@/lib/personal-note-markdown";
import { useVoiceDictation } from "@/hooks/useVoiceDictation";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { MarkdownBody } from "@/components/MarkdownBody";
import { ScheduleNoteHandoffDialog } from "@/components/ScheduleNoteHandoffDialog";

type FilterTab = "all" | "pinned" | "scheduled" | "handed_off" | "archived";
type SortMode = "updated" | "created" | "title" | "scheduled";
type ViewMode = "split" | "grid" | "timeline";

const RECURRENCE_LABELS: Record<PersonalNoteRecurrence, string> = {
  none: "",
  daily: "Daily",
  weekdays: "Weekdays",
  weekly: "Weekly",
  monthly: "Monthly",
};

function stripMarkdownPreview(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\[\[([^\]]+)\]\]/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/[*_~>]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function formatShortDateTime(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatRelativeTime(iso: string): string {
  const date = new Date(iso);
  const diffMs = Date.now() - date.getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 1) return "Just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 7) return `${diffDay}d ago`;
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function issueStatusTone(status: string | null): string {
  if (status === "done") return "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300";
  if (status === "in_progress" || status === "in_review") {
    return "bg-blue-500/15 text-blue-700 dark:text-blue-300";
  }
  if (status === "blocked") return "bg-rose-500/15 text-rose-700 dark:text-rose-300";
  return "bg-muted text-muted-foreground";
}

function buildNewIssueDefaultsFromNote(note: PersonalNote) {
  const bodyParts: string[] = [];
  if (note.body.trim()) bodyParts.push(note.body.trim());
  if (note.tags.length > 0) {
    bodyParts.push(`_From personal note · Tags: ${note.tags.map((t) => `#${t}`).join(" ")}_`);
  }
  return {
    title: note.title,
    description: bodyParts.join("\n\n"),
    projectId: note.projectId ?? undefined,
    status: "todo",
  };
}

export function Notes() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { openNewNote, openNewIssue } = useDialogActions();
  const { pushToast } = useToastActions();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { noteId: routeNoteId } = useParams<{ noteId?: string }>();

  const [filterTab, setFilterTab] = useState<FilterTab>("all");
  const [sortMode, setSortMode] = useState<SortMode>("updated");
  const [viewMode, setViewMode] = useState<ViewMode>("split");
  const [search, setSearch] = useState("");
  const [selectedTag, setSelectedTag] = useState<string | null>(null);
  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(routeNoteId ?? null);
  const [mobileEditorOpen, setMobileEditorOpen] = useState(Boolean(routeNoteId));
  const [scheduleDialogNote, setScheduleDialogNote] = useState<PersonalNote | null>(null);

  useEffect(() => {
    setBreadcrumbs([{ label: "Personal Notes" }]);
  }, [setBreadcrumbs]);

  useEffect(() => {
    if (routeNoteId) setSelectedNoteId(routeNoteId);
  }, [routeNoteId]);

  const { data: notes = [], isLoading, error } = useQuery({
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

  const agentById = useMemo(
    () => new Map<string, Agent>(agents.map((a) => [a.id, a])),
    [agents],
  );
  const projectById = useMemo(
    () => new Map<string, Project>(projects.map((p) => [p.id, p])),
    [projects],
  );

  const allTags = useMemo(() => {
    const counts = new Map<string, number>();
    for (const note of notes) {
      if (note.archived) continue;
      for (const tag of note.tags) {
        counts.set(tag, (counts.get(tag) ?? 0) + 1);
      }
    }
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 14);
  }, [notes]);

  const counts = useMemo(() => {
    let active = 0;
    let pinned = 0;
    let scheduled = 0;
    let handedOff = 0;
    let archived = 0;
    for (const note of notes) {
      if (note.archived) {
        archived += 1;
        continue;
      }
      active += 1;
      if (note.pinned) pinned += 1;
      if (note.scheduledStatus === "pending") scheduled += 1;
      if (note.handedOffIssueId || (note.linkedTasks?.length ?? 0) > 0) handedOff += 1;
    }
    return { active, pinned, scheduled, handedOff, archived };
  }, [notes]);

  const filteredNotes = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = notes.filter((note) => {
      if (filterTab === "archived") {
        if (!note.archived) return false;
      } else {
        if (note.archived) return false;
        if (filterTab === "pinned" && !note.pinned) return false;
        if (filterTab === "scheduled" && note.scheduledStatus !== "pending") return false;
        if (filterTab === "handed_off" && !note.handedOffIssueId && (note.linkedTasks?.length ?? 0) === 0) {
          return false;
        }
      }
      if (selectedTag && !note.tags.includes(selectedTag)) return false;
      if (q) {
        const hay = `${note.title} ${note.body} ${note.tags.join(" ")}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    return [...list].sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      if (sortMode === "title") return a.title.localeCompare(b.title);
      if (sortMode === "created") return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      if (sortMode === "scheduled") {
        const at = a.scheduledFor ? new Date(a.scheduledFor).getTime() : Number.MAX_SAFE_INTEGER;
        const bt = b.scheduledFor ? new Date(b.scheduledFor).getTime() : Number.MAX_SAFE_INTEGER;
        return at - bt;
      }
      return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    });
  }, [notes, filterTab, selectedTag, search, sortMode]);

  const selectedNote = useMemo(
    () =>
      filteredNotes.find((n) => n.id === selectedNoteId) ??
      notes.find((n) => n.id === selectedNoteId) ??
      filteredNotes[0] ??
      null,
    [filteredNotes, notes, selectedNoteId],
  );

  useEffect(() => {
    if (!selectedNoteId && filteredNotes[0]) {
      setSelectedNoteId(filteredNotes[0].id);
    }
  }, [filteredNotes, selectedNoteId]);

  const openDailyMutation = useMutation({
    mutationFn: () => {
      const todayLocal = new Date();
      const pad = (n: number) => String(n).padStart(2, "0");
      const dateStr = `${todayLocal.getFullYear()}-${pad(todayLocal.getMonth() + 1)}-${pad(todayLocal.getDate())}`;
      return personalNotesApi.openDaily(selectedCompanyId!, dateStr);
    },
    onSuccess: (dailyNote) => {
      queryClient.setQueryData<PersonalNote[]>(
        queryKeys.personalNotes.list(selectedCompanyId!),
        (prev) => {
          if (!prev) return [dailyNote];
          const exists = prev.some((n) => n.id === dailyNote.id);
          return exists ? prev.map((n) => (n.id === dailyNote.id ? dailyNote : n)) : [dailyNote, ...prev];
        },
      );
      setFilterTab("all");
      setSelectedTag(null);
      setSearch("");
      setViewMode("split");
      setSelectedNoteId(dailyNote.id);
    },
    onError: (err) => {
      pushToast({
        title: "Could not open Today's Note",
        body: err instanceof Error ? err.message : String(err),
        tone: "error",
      });
    },
  });

  const updateNoteMutation = useMutation({
    mutationFn: ({ noteId, patch }: { noteId: string; patch: Parameters<typeof personalNotesApi.update>[2] }) =>
      personalNotesApi.update(selectedCompanyId!, noteId, patch),
    onSuccess: (updated) => {
      queryClient.setQueryData<PersonalNote[]>(
        queryKeys.personalNotes.list(selectedCompanyId!),
        (prev) => (prev ? prev.map((n) => (n.id === updated.id ? updated : n)) : [updated]),
      );
    },
    onError: (err) => {
      pushToast({
        title: "Could not save note",
        body: err instanceof Error ? err.message : String(err),
        tone: "error",
      });
    },
  });

  const deleteNoteMutation = useMutation({
    mutationFn: (noteId: string) => personalNotesApi.remove(selectedCompanyId!, noteId),
    onSuccess: (_res, noteId) => {
      queryClient.setQueryData<PersonalNote[]>(
        queryKeys.personalNotes.list(selectedCompanyId!),
        (prev) => (prev ? prev.filter((n) => n.id !== noteId) : []),
      );
      if (selectedNoteId === noteId) setSelectedNoteId(null);
      pushToast({ title: "Note deleted", tone: "info" });
    },
  });

  const cancelScheduleMutation = useMutation({
    mutationFn: (noteId: string) => personalNotesApi.cancelScheduledHandoff(selectedCompanyId!, noteId),
    onSuccess: (updated) => {
      queryClient.setQueryData<PersonalNote[]>(
        queryKeys.personalNotes.list(selectedCompanyId!),
        (prev) => (prev ? prev.map((n) => (n.id === updated.id ? updated : n)) : [updated]),
      );
      pushToast({ title: "Scheduled handoff cancelled", tone: "info" });
    },
  });

  const dispatchNowMutation = useMutation({
    mutationFn: (noteId: string) => personalNotesApi.dispatchNow(selectedCompanyId!, noteId),
    onSuccess: (updated) => {
      queryClient.setQueryData<PersonalNote[]>(
        queryKeys.personalNotes.list(selectedCompanyId!),
        (prev) => (prev ? prev.map((n) => (n.id === updated.id ? updated : n)) : [updated]),
      );
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(selectedCompanyId!) });
      pushToast({
        title: "Sent to agent",
        body: updated.handedOffIssueIdentifier
          ? `Created ${updated.handedOffIssueIdentifier}`
          : updated.title,
        tone: "success",
      });
    },
    onError: (err) => {
      pushToast({
        title: "Could not send to agent",
        body: err instanceof Error ? err.message : String(err),
        tone: "error",
      });
    },
  });

  const recordHandoffMutation = useMutation({
    mutationFn: ({
      noteId,
      issueId,
      sourceLine,
    }: {
      noteId: string;
      issueId: string;
      sourceLine?: string | null;
    }) => personalNotesApi.recordHandoff(selectedCompanyId!, noteId, issueId, sourceLine ?? null),
    onSuccess: (updated) => {
      queryClient.setQueryData<PersonalNote[]>(
        queryKeys.personalNotes.list(selectedCompanyId!),
        (prev) => (prev ? prev.map((n) => (n.id === updated.id ? updated : n)) : [updated]),
      );
    },
  });

  const splitChecklistMutation = useMutation({
    mutationFn: ({
      noteId,
      items,
      agentId,
      priority,
    }: {
      noteId: string;
      items: string[];
      agentId: string | null;
      priority: "low" | "medium" | "high" | "critical";
    }) =>
      personalNotesApi.splitChecklistToTasks(selectedCompanyId!, noteId, {
        items,
        agentId,
        projectId: selectedNote?.projectId ?? null,
        priority,
        issueStatus: "todo",
      }),
    onSuccess: ({ note: updated, createdCount }) => {
      queryClient.setQueryData<PersonalNote[]>(
        queryKeys.personalNotes.list(selectedCompanyId!),
        (prev) => (prev ? prev.map((n) => (n.id === updated.id ? updated : n)) : [updated]),
      );
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(selectedCompanyId!) });
      pushToast({
        title: `Created ${createdCount} agent ${createdCount === 1 ? "task" : "tasks"}`,
        body: `Delegated from “${updated.title}”`,
        tone: "success",
      });
    },
    onError: (err) => {
      pushToast({
        title: "Could not split checklist into tasks",
        body: err instanceof Error ? err.message : String(err),
        tone: "error",
      });
    },
  });

  const sendToCanvasMutation = useMutation({
    mutationFn: async (note: PersonalNote) => {
      const boards = await planningCanvasesApi.list(selectedCompanyId!);
      let target = boards[0];
      if (!target) {
        target = await planningCanvasesApi.create(selectedCompanyId!, {
          title: "Main Planning Board",
          description: "",
        });
      }
      const existingNodes = target.data.nodes ?? [];
      const nextZ = existingNodes.reduce((m, n) => Math.max(m, n.zIndex), 1) + 1;
      const offset = (existingNodes.length % 6) * 28;
      const color: CanvasNodeColor =
        note.color === "amber" ||
        note.color === "blue" ||
        note.color === "emerald" ||
        note.color === "rose" ||
        note.color === "violet"
          ? note.color
          : "slate";
      const newNode = {
        id: createCanvasId("note"),
        kind: "note" as const,
        x: 120 + offset,
        y: 120 + offset,
        width: 280,
        height: 190,
        zIndex: nextZ,
        color,
        title: note.title,
        content: note.body,
        noteId: note.id,
        handedOffIssueId: note.handedOffIssueId,
        handedOffIssueIdentifier: note.handedOffIssueIdentifier,
      };
      return planningCanvasesApi.update(selectedCompanyId!, target.id, {
        data: {
          ...target.data,
          nodes: [...existingNodes, newNode],
        },
      });
    },
    onSuccess: (board) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.planningCanvases.list(selectedCompanyId!) });
      pushToast({
        title: "Added to Planning Canvas",
        body: `Placed on “${board.title}”`,
        tone: "success",
      });
    },
    onError: (err) => {
      pushToast({
        title: "Could not add to Planning Canvas",
        body: err instanceof Error ? err.message : String(err),
        tone: "error",
      });
    },
  });

  function handleGiveToAgent(note: PersonalNote) {
    openNewIssue(buildNewIssueDefaultsFromNote(note), {
      onCreated: (createdIssue) => {
        recordHandoffMutation.mutate({ noteId: note.id, issueId: createdIssue.id });
        pushToast({
          title: "Given to agent",
          body: `${createdIssue.identifier ?? createdIssue.title} created from your note.`,
          tone: "success",
        });
      },
    });
  }

  function handleGiveChecklistLineToAgent(note: PersonalNote, lineText: string) {
    openNewIssue(
      {
        title: lineText.slice(0, 200),
        description: [
          `Delegated from personal note **${note.title}**.`,
          "",
          note.body.trim() ? `### Note Context\n\n${note.body.trim()}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
        projectId: note.projectId ?? undefined,
        status: "todo",
      },
      {
        onCreated: (createdIssue) => {
          recordHandoffMutation.mutate({
            noteId: note.id,
            issueId: createdIssue.id,
            sourceLine: lineText,
          });
          pushToast({
            title: "Checklist item given to agent",
            body: `${createdIssue.identifier ?? createdIssue.title} linked to your note.`,
            tone: "success",
          });
        },
      },
    );
  }

  function handleCreateNote(defaults?: Parameters<typeof openNewNote>[0]) {
    openNewNote(defaults ?? {}, {
      onCreated: (created) => {
        setSelectedNoteId(created.id);
        setViewMode("split");
        if (filterTab === "archived") setFilterTab("all");
      },
    });
  }

  function handleOpenOrCreateWikiLink(targetTitle: string) {
    const match = notes.find(
      (n) => !n.archived && n.title.trim().toLowerCase() === targetTitle.trim().toLowerCase(),
    );
    if (match) {
      setSelectedNoteId(match.id);
      setViewMode("split");
      return;
    }
    handleCreateNote({ title: targetTitle });
  }

  if (!selectedCompanyId) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-sm text-muted-foreground">
        Select a company to view your personal notes.
      </div>
    );
  }

  const upcomingScheduled = useMemo(
    () =>
      notes
        .filter((n) => !n.archived && (n.scheduledStatus === "pending" || n.scheduledStatus === "failed"))
        .sort((a, b) => {
          const at = a.scheduledFor ? new Date(a.scheduledFor).getTime() : Number.MAX_SAFE_INTEGER;
          const bt = b.scheduledFor ? new Date(b.scheduledFor).getTime() : Number.MAX_SAFE_INTEGER;
          return at - bt;
        }),
    [notes],
  );

  const recentDispatches = useMemo(
    () =>
      notes
        .filter((n) => n.handedOffAt || (n.linkedTasks?.length ?? 0) > 0)
        .sort((a, b) => {
          const at = a.handedOffAt ? new Date(a.handedOffAt).getTime() : 0;
          const bt = b.handedOffAt ? new Date(b.handedOffAt).getTime() : 0;
          return bt - at;
        })
        .slice(0, 15),
    [notes],
  );

  // On phones an open note takes the whole screen; the page header and filters return with "Back to notes".
  const mobileEditorFocused = viewMode === "split" && mobileEditorOpen && Boolean(selectedNote);

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      {/* Page Header */}
      <div className={cn("flex flex-wrap items-center justify-between gap-3 border-b border-border px-3 py-3 md:px-5 md:py-3.5", mobileEditorFocused && "max-md:hidden")}>
        <div className="flex items-center gap-3">
          <div className="flex size-9 items-center justify-center rounded-lg border border-border bg-muted/40">
            <NotebookPen className="size-4.5 text-foreground" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-base font-semibold tracking-tight text-foreground">Personal Notes</h1>
              <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                Private to you
              </span>
              <span className="hidden rounded border border-border px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground sm:inline">
                ⇧N quick note
              </span>
            </div>
            <p className="text-xs text-muted-foreground">
              Thinking-to-execution cockpit — dictate, structure as agent briefs, delegate checklist lines, or schedule recurring handoffs.
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={openDailyMutation.isPending}
            onClick={() => openDailyMutation.mutate()}
          >
            <CalendarDays className="size-3.5 text-blue-500" />
            {openDailyMutation.isPending ? "Opening…" : "Today's Note"}
          </Button>

          <div className="inline-flex rounded-md border border-border bg-muted/30 p-0.5">
            <button
              type="button"
              aria-label="Split view"
              title="Split view"
              onClick={() => setViewMode("split")}
              className={cn(
                "inline-flex items-center gap-1 rounded px-2 py-1 text-xs transition-colors",
                viewMode === "split" ? "bg-background font-medium text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground",
              )}
            >
              <PanelLeft className="size-3.5" />
              Split
            </button>
            <button
              type="button"
              aria-label="Grid view"
              title="Grid view"
              onClick={() => setViewMode("grid")}
              className={cn(
                "inline-flex items-center gap-1 rounded px-2 py-1 text-xs transition-colors",
                viewMode === "grid" ? "bg-background font-medium text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground",
              )}
            >
              <LayoutGrid className="size-3.5" />
              Grid
            </button>
            <button
              type="button"
              aria-label="Handoffs timeline"
              title="Handoffs timeline"
              onClick={() => setViewMode("timeline")}
              className={cn(
                "inline-flex items-center gap-1 rounded px-2 py-1 text-xs transition-colors",
                viewMode === "timeline" ? "bg-background font-medium text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground",
              )}
            >
              <CalendarClock className="size-3.5" />
              Handoffs
              {counts.scheduled > 0 ? (
                <span className="rounded-full bg-amber-500/20 px-1.5 text-[10px] font-semibold text-amber-700 dark:text-amber-300">
                  {counts.scheduled}
                </span>
              ) : null}
            </button>
          </div>

          <Button size="sm" onClick={() => handleCreateNote()}>
            <Plus className="size-4" />
            New note
          </Button>
        </div>
      </div>

      {/* Filter & Search Bar (hidden in timeline view) */}
      {viewMode !== "timeline" ? (
        <div className={cn("contents", mobileEditorFocused && "max-md:hidden")}>
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/80 bg-muted/15 px-3 py-2 md:px-5">
            <div className="flex flex-wrap items-center gap-1">
              {(
                [
                  { id: "all", label: "All", count: counts.active },
                  { id: "pinned", label: "Pinned", count: counts.pinned },
                  { id: "scheduled", label: "Scheduled", count: counts.scheduled },
                  { id: "handed_off", label: "Given to agent", count: counts.handedOff },
                  { id: "archived", label: "Archived", count: counts.archived },
                ] as const
              ).map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setFilterTab(tab.id)}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                    filterTab === tab.id
                      ? "bg-foreground text-background"
                      : "text-muted-foreground hover:bg-accent hover:text-foreground",
                  )}
                >
                  <span>{tab.label}</span>
                  <span
                    className={cn(
                      "rounded-full px-1.5 text-[10px]",
                      filterTab === tab.id ? "bg-background/20 text-background" : "bg-muted text-muted-foreground",
                    )}
                  >
                    {tab.count}
                  </span>
                </button>
              ))}
            </div>

            <div className="flex w-full min-w-0 items-center gap-2 md:w-auto">
              <div className="relative min-w-0 flex-1 md:flex-none">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <input
                  type="search"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search notes…"
                  className="h-7 w-full rounded-md border border-border bg-background pl-8 pr-2.5 text-xs text-foreground placeholder:text-muted-foreground/60 outline-none focus:border-ring md:w-56"
                />
              </div>
              <OptionSelect
                ariaLabel="Sort notes"
                placeholder="Sort"
                triggerClassName="h-7 px-2 text-xs font-normal"
                value={sortMode}
                items={[
                  { value: "updated", label: "Last updated" },
                  { value: "created", label: "Newest" },
                  { value: "title", label: "Title (A–Z)" },
                  { value: "scheduled", label: "Scheduled time" },
                ]}
                onChange={(next) => setSortMode(next as SortMode)}
              />
            </div>
          </div>

          {allTags.length > 0 ? (
            <div className="flex items-center gap-1.5 overflow-x-auto border-b border-border/60 px-3 py-1.5 md:px-5">
              <Tag className="size-3 shrink-0 text-muted-foreground" />
              {selectedTag ? (
                <button
                  type="button"
                  onClick={() => setSelectedTag(null)}
                  className="inline-flex items-center gap-1 rounded-full bg-foreground px-2 py-0.5 text-[11px] font-medium text-background"
                >
                  #{selectedTag}
                  <X className="size-2.5" />
                </button>
              ) : null}
              {allTags
                .filter(([tag]) => tag !== selectedTag)
                .map(([tag, count]) => (
                  <button
                    key={tag}
                    type="button"
                    onClick={() => setSelectedTag(tag)}
                    className="inline-flex shrink-0 items-center gap-1 rounded-full border border-border bg-background px-2 py-0.5 text-[11px] text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground"
                  >
                    #{tag}
                    <span className="text-[10px] opacity-60">{count}</span>
                  </button>
                ))}
            </div>
          ) : null}
        </div>
      ) : null}

      {/* Main Content */}
      {isLoading ? (
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          Loading your notes…
        </div>
      ) : error ? (
        <div className="flex flex-1 items-center justify-center p-6 text-sm text-destructive">
          Failed to load notes: {error instanceof Error ? error.message : String(error)}
        </div>
      ) : viewMode === "timeline" ? (
        /* Dedicated Handoffs Timeline View */
        <div className="flex-1 overflow-y-auto p-6">
          <div className="mx-auto flex max-w-4xl flex-col gap-6">
            <section className="flex flex-col gap-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <CalendarClock className="size-4 text-amber-500" />
                  <h2 className="text-sm font-semibold text-foreground">
                    Upcoming & Recurring Agent Handoffs ({upcomingScheduled.length})
                  </h2>
                </div>
              </div>

              {upcomingScheduled.length === 0 ? (
                <div className="rounded-xl border border-dashed border-border bg-muted/20 p-6 text-center text-xs text-muted-foreground">
                  No scheduled handoffs queued right now. Open any note and click{" "}
                  <strong className="text-foreground">Schedule for agent</strong> to queue one-off or recurring dispatches.
                </div>
              ) : (
                <div className="flex flex-col gap-2.5">
                  {upcomingScheduled.map((note) => {
                    const agent = note.scheduledAgentId ? agentById.get(note.scheduledAgentId) : null;
                    const recurrenceLabel = RECURRENCE_LABELS[note.scheduledRecurrence ?? "none"];
                    return (
                      <div
                        key={note.id}
                        className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card p-4"
                      >
                        <div className="min-w-0 flex-1 space-y-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <button
                              type="button"
                              onClick={() => {
                                setSelectedNoteId(note.id);
                                setViewMode("split");
                              }}
                              className="truncate text-sm font-semibold text-foreground hover:underline"
                            >
                              {note.title}
                            </button>
                            {recurrenceLabel ? (
                              <span className="inline-flex items-center gap-1 rounded-full bg-violet-500/15 px-2 py-0.5 text-[10px] font-medium text-violet-700 dark:text-violet-300">
                                <Repeat className="size-2.5" />
                                {recurrenceLabel}
                              </span>
                            ) : null}
                            {note.scheduledStatus === "failed" ? (
                              <span className="inline-flex items-center gap-1 rounded-full bg-destructive/15 px-2 py-0.5 text-[10px] font-medium text-destructive">
                                <AlertTriangle className="size-2.5" />
                                Failed
                              </span>
                            ) : null}
                          </div>
                          <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                            <span className="inline-flex items-center gap-1 text-amber-700 dark:text-amber-300">
                              <Clock className="size-3.5" />
                              {formatShortDateTime(note.scheduledFor)}
                            </span>
                            <span>Agent: {agent ? agent.name : "Unassigned"}</span>
                            <span className="capitalize">Priority: {note.scheduledPriority}</span>
                          </div>
                          {note.scheduledInstructions ? (
                            <p className="line-clamp-1 text-xs text-muted-foreground">
                              “{note.scheduledInstructions}”
                            </p>
                          ) : null}
                          {note.scheduledError ? (
                            <p className="text-xs text-destructive">{note.scheduledError}</p>
                          ) : null}
                        </div>

                        <div className="flex items-center gap-1.5">
                          <Button
                            type="button"
                            size="xs"
                            variant="secondary"
                            disabled={dispatchNowMutation.isPending}
                            onClick={() => dispatchNowMutation.mutate(note.id)}
                          >
                            <Send className="size-3" />
                            Send now
                          </Button>
                          <Button
                            type="button"
                            size="xs"
                            variant="outline"
                            onClick={() => setScheduleDialogNote(note)}
                          >
                            Edit
                          </Button>
                          <Button
                            type="button"
                            size="xs"
                            variant="ghost"
                            onClick={() => cancelScheduleMutation.mutate(note.id)}
                          >
                            Cancel
                          </Button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </section>

            <section className="flex flex-col gap-3">
              <div className="flex items-center gap-2">
                <CheckCircle2 className="size-4 text-emerald-500" />
                <h2 className="text-sm font-semibold text-foreground">
                  Recent Dispatches & Live Task Links ({recentDispatches.length})
                </h2>
              </div>
              {recentDispatches.length === 0 ? (
                <div className="rounded-xl border border-dashed border-border bg-muted/20 p-6 text-center text-xs text-muted-foreground">
                  Notes you hand off to agents will show up here with live task status tracking.
                </div>
              ) : (
                <div className="flex flex-col gap-2">
                  {recentDispatches.map((note) => (
                    <div
                      key={note.id}
                      className="flex flex-col gap-2 rounded-xl border border-border bg-card p-3.5"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <button
                          type="button"
                          onClick={() => {
                            setSelectedNoteId(note.id);
                            setViewMode("split");
                          }}
                          className="truncate text-sm font-medium text-foreground hover:underline"
                        >
                          {note.title}
                        </button>
                        {note.handedOffAt ? (
                          <span className="shrink-0 text-[11px] text-muted-foreground">
                            Last sent {formatRelativeTime(note.handedOffAt)}
                          </span>
                        ) : null}
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {(note.linkedTasks?.length ?? 0) > 0 ? (
                          note.linkedTasks.map((task) => (
                            <Link
                              key={task.id}
                              to={`/issues/${task.issueIdentifier ?? task.issueId}`}
                              className={cn(
                                "inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-[11px] font-medium hover:underline",
                                issueStatusTone(task.issueStatus),
                              )}
                            >
                              <span>{task.issueIdentifier ?? "Task"}</span>
                              <span className="max-w-48 truncate font-normal">
                                {task.issueTitle ?? task.sourceLine ?? ""}
                              </span>
                              <span className="opacity-70">· {task.issueStatus ?? "open"}</span>
                            </Link>
                          ))
                        ) : note.handedOffIssueId ? (
                          <Link
                            to={`/issues/${note.handedOffIssueIdentifier ?? note.handedOffIssueId}`}
                            className="inline-flex items-center gap-1.5 rounded-md bg-emerald-500/15 px-2 py-0.5 text-[11px] font-medium text-emerald-700 hover:underline dark:text-emerald-300"
                          >
                            {note.handedOffIssueIdentifier ?? "Open task"}
                            <ExternalLink className="size-3" />
                          </Link>
                        ) : null}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </div>
        </div>
      ) : filteredNotes.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-4 p-10 text-center">
          <div className="flex size-12 items-center justify-center rounded-xl border border-border bg-muted/40">
            <NotebookPen className="size-5 text-muted-foreground" />
          </div>
          <div className="max-w-md space-y-1">
            <h2 className="text-sm font-semibold text-foreground">
              {notes.length === 0 ? "Start your personal thinking space" : "No notes match your filter"}
            </h2>
            <p className="text-xs text-muted-foreground">
              {notes.length === 0
                ? "Open Today's Note, pick a template, or dictate a brain dump. Turn any note or checklist item into an agent task immediately or on a schedule."
                : "Try clearing your search or switching filter tabs."}
            </p>
          </div>
          {notes.length === 0 ? (
            <div className="flex flex-wrap items-center justify-center gap-2">
              <Button size="sm" onClick={() => openDailyMutation.mutate()}>
                <CalendarDays className="size-4" />
                Open Today's Note
              </Button>
              <Button size="sm" variant="outline" onClick={() => handleCreateNote()}>
                <Plus className="size-4" />
                Blank note
              </Button>
              {PERSONAL_NOTE_TEMPLATES.slice(0, 2).map((tpl) => (
                <Button
                  key={tpl.id}
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    handleCreateNote({
                      title: tpl.defaultTitle,
                      body: tpl.body,
                      color: tpl.color,
                      tags: tpl.tags,
                    })
                  }
                >
                  <Sparkles className="size-3.5" />
                  {tpl.label}
                </Button>
              ))}
            </div>
          ) : (
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setSearch("");
                setSelectedTag(null);
                setFilterTab("all");
              }}
            >
              Reset filters
            </Button>
          )}
        </div>
      ) : viewMode === "grid" ? (
        <div className="flex-1 overflow-y-auto p-5">
          <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2 lg:grid-cols-3">
            {filteredNotes.map((note) => {
              const colorStyle = NOTE_COLOR_STYLES[note.color] ?? NOTE_COLOR_STYLES.default;
              const scheduledAgent = note.scheduledAgentId ? agentById.get(note.scheduledAgentId) : null;
              const snippet = stripMarkdownPreview(note.body);
              const checklist = parseChecklistItems(note.body);
              const checkedCount = checklist.filter((i) => i.checked).length;
              return (
                <div
                  key={note.id}
                  onClick={() => {
                    setSelectedNoteId(note.id);
                    setViewMode("split");
                  }}
                  className={cn(
                    "group relative flex cursor-pointer flex-col justify-between overflow-hidden rounded-xl border border-border p-4 transition-all hover:border-foreground/30 hover:shadow-sm",
                    colorStyle.tint,
                  )}
                >
                  <div className={cn("absolute inset-x-0 top-0 h-1", colorStyle.bar)} />
                  <div>
                    <div className="flex items-start justify-between gap-2">
                      <h3 className="line-clamp-1 text-sm font-semibold text-foreground">
                        {note.title}
                      </h3>
                      <button
                        type="button"
                        aria-label={note.pinned ? "Unpin note" : "Pin note"}
                        onClick={(e) => {
                          e.stopPropagation();
                          updateNoteMutation.mutate({ noteId: note.id, patch: { pinned: !note.pinned } });
                        }}
                        className={cn(
                          "rounded p-1 text-muted-foreground transition-colors hover:bg-background/80 hover:text-foreground",
                          note.pinned ? "text-amber-500 opacity-100" : "opacity-0 group-hover:opacity-100",
                        )}
                      >
                        <Pin className={cn("size-3.5", note.pinned && "fill-current")} />
                      </button>
                    </div>
                    <p className="mt-1.5 line-clamp-3 text-xs leading-relaxed text-muted-foreground">
                      {snippet || "Empty note"}
                    </p>
                  </div>

                  <div className="mt-4 flex flex-col gap-2">
                    <div className="flex flex-wrap items-center gap-1.5">
                      {checklist.length > 0 ? (
                        <span className="inline-flex items-center gap-1 rounded bg-background/80 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                          <ListChecks className="size-2.5" />
                          {checkedCount}/{checklist.length}
                        </span>
                      ) : null}
                      {note.tags.slice(0, 3).map((tag) => (
                        <span
                          key={tag}
                          className="rounded bg-background/80 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground"
                        >
                          #{tag}
                        </span>
                      ))}
                    </div>

                    {note.scheduledStatus === "pending" && note.scheduledFor ? (
                      <div className="inline-flex items-center gap-1.5 rounded-md bg-amber-500/15 px-2 py-1 text-[11px] font-medium text-amber-700 dark:text-amber-300">
                        <CalendarClock className="size-3 shrink-0" />
                        <span className="truncate">
                          {formatShortDateTime(note.scheduledFor)}
                          {note.scheduledRecurrence !== "none" ? ` · ${RECURRENCE_LABELS[note.scheduledRecurrence]}` : ""}
                          {scheduledAgent ? ` · ${scheduledAgent.name}` : ""}
                        </span>
                      </div>
                    ) : (note.linkedTasks?.length ?? 0) > 0 ? (
                      <div className="inline-flex items-center gap-1.5 rounded-md bg-emerald-500/15 px-2 py-1 text-[11px] font-medium text-emerald-700 dark:text-emerald-300">
                        <CheckCircle2 className="size-3 shrink-0" />
                        <span>
                          {note.linkedTasks.length} linked {note.linkedTasks.length === 1 ? "task" : "tasks"}
                        </span>
                      </div>
                    ) : null}

                    <div className="flex items-center justify-between border-t border-border/60 pt-2">
                      <span className="text-[11px] text-muted-foreground">
                        {formatRelativeTime(note.updatedAt)}
                      </span>
                      <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                        <Button type="button" variant="ghost" size="xs" onClick={() => handleGiveToAgent(note)}>
                          <Send className="size-3" />
                          Give
                        </Button>
                        <Button type="button" variant="ghost" size="xs" onClick={() => setScheduleDialogNote(note)}>
                          <CalendarClock className="size-3" />
                          Schedule
                        </Button>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        /* Split Master-Detail View */
        <div className="flex min-h-0 flex-1 overflow-hidden">
          {/* Left Notes List */}
          <div
            className={cn(
              "w-full shrink-0 flex-col overflow-y-auto border-r border-border md:flex md:w-80 lg:w-96",
              mobileEditorOpen && selectedNote ? "hidden" : "flex",
            )}
          >
            {filteredNotes.map((note) => {
              const isSelected = selectedNote?.id === note.id;
              const colorStyle = NOTE_COLOR_STYLES[note.color] ?? NOTE_COLOR_STYLES.default;
              const scheduledAgent = note.scheduledAgentId ? agentById.get(note.scheduledAgentId) : null;
              const project = note.projectId ? projectById.get(note.projectId) : null;
              const snippet = stripMarkdownPreview(note.body);
              const checklist = parseChecklistItems(note.body);
              const checkedCount = checklist.filter((i) => i.checked).length;
              return (
                <div
                  key={note.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => {
                    setSelectedNoteId(note.id);
                    setMobileEditorOpen(true);
                    if (routeNoteId) navigate("/notes", { replace: true });
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setSelectedNoteId(note.id);
                      setMobileEditorOpen(true);
                    }
                  }}
                  className={cn(
                    "group relative flex cursor-pointer flex-col gap-1.5 border-b border-border/70 px-4 py-3 text-left transition-colors outline-none focus-visible:bg-accent/60",
                    isSelected ? "bg-accent/70" : "hover:bg-accent/35",
                  )}
                >
                  <div className={cn("absolute inset-y-0 left-0 w-1", colorStyle.bar)} />

                  <div className="flex items-start justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-1.5">
                      {note.pinned ? (
                        <Pin className="size-3 shrink-0 fill-amber-500 text-amber-500" />
                      ) : null}
                      {note.dailyDate ? (
                        <CalendarDays className="size-3 shrink-0 text-blue-500" />
                      ) : null}
                      <span className="truncate text-sm font-medium text-foreground">
                        {note.title}
                      </span>
                    </div>
                    <span className="shrink-0 text-[11px] text-muted-foreground">
                      {formatRelativeTime(note.updatedAt)}
                    </span>
                  </div>

                  {snippet ? (
                    <p className="line-clamp-2 text-xs leading-relaxed text-muted-foreground">
                      {snippet}
                    </p>
                  ) : (
                    <p className="text-xs italic text-muted-foreground/60">No content yet</p>
                  )}

                  <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                    {checklist.length > 0 ? (
                      <span className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                        <ListChecks className="size-2.5" />
                        {checkedCount}/{checklist.length}
                      </span>
                    ) : null}
                    {note.scheduledStatus === "pending" && note.scheduledFor ? (
                      <span className="inline-flex items-center gap-1 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-300">
                        <CalendarClock className="size-2.5" />
                        {formatShortDateTime(note.scheduledFor)}
                        {note.scheduledRecurrence !== "none" ? ` · ${RECURRENCE_LABELS[note.scheduledRecurrence]}` : ""}
                        {scheduledAgent ? ` · ${scheduledAgent.name}` : ""}
                      </span>
                    ) : null}
                    {note.scheduledStatus === "failed" ? (
                      <span className="inline-flex items-center gap-1 rounded bg-destructive/15 px-1.5 py-0.5 text-[10px] font-medium text-destructive">
                        <AlertTriangle className="size-2.5" />
                        Handoff failed
                      </span>
                    ) : null}
                    {(note.linkedTasks?.length ?? 0) > 0 ? (
                      <span className="inline-flex items-center gap-1 rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 dark:text-emerald-300">
                        <CheckCircle2 className="size-2.5" />
                        {note.linkedTasks.length === 1
                          ? note.linkedTasks[0]?.issueIdentifier ?? "1 task"
                          : `${note.linkedTasks.length} tasks`}
                      </span>
                    ) : note.handedOffIssueId ? (
                      <span className="inline-flex items-center gap-1 rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 dark:text-emerald-300">
                        <CheckCircle2 className="size-2.5" />
                        {note.handedOffIssueIdentifier ?? "Given to agent"}
                      </span>
                    ) : null}
                    {project ? (
                      <span className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                        <FolderOpen className="size-2.5" />
                        {project.name}
                      </span>
                    ) : null}
                    {note.tags.slice(0, 2).map((tag) => (
                      <span
                        key={tag}
                        className="rounded bg-secondary px-1.5 py-0.5 text-[10px] text-secondary-foreground"
                      >
                        #{tag}
                      </span>
                    ))}
                    {note.tags.length > 2 ? (
                      <span className="text-[10px] text-muted-foreground">+{note.tags.length - 2}</span>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Right Editor Pane */}
          <div
            className={cn(
              "min-w-0 flex-1 flex-col overflow-hidden md:flex",
              mobileEditorOpen && selectedNote ? "flex" : "hidden",
            )}
          >
            {mobileEditorOpen && selectedNote ? (
              <div className="flex items-center border-b border-border bg-muted/20 px-3 py-2 md:hidden">
                <button
                  type="button"
                  onClick={() => setMobileEditorOpen(false)}
                  className="inline-flex min-h-9 items-center gap-1 text-sm font-medium text-foreground hover:underline"
                >
                  ← Back to notes
                </button>
              </div>
            ) : null}
            {selectedNote ? (
              <NoteEditorPane
                key={selectedNote.id}
                note={selectedNote}
                allNotes={notes}
                agents={agents}
                projects={projects}
                agentById={agentById}
                isSaving={updateNoteMutation.isPending}
                isDispatching={dispatchNowMutation.isPending}
                isSplitting={splitChecklistMutation.isPending}
                onSave={(patch) =>
                  updateNoteMutation.mutate({ noteId: selectedNote.id, patch })
                }
                onDelete={() => deleteNoteMutation.mutate(selectedNote.id)}
                onGiveToAgent={() => handleGiveToAgent(selectedNote)}
                onGiveChecklistLine={(lineText) => handleGiveChecklistLineToAgent(selectedNote, lineText)}
                onSplitChecklist={(items, agentId, priority) =>
                  splitChecklistMutation.mutate({
                    noteId: selectedNote.id,
                    items,
                    agentId,
                    priority,
                  })
                }
                onOpenSchedule={() => setScheduleDialogNote(selectedNote)}
                onCancelSchedule={() => cancelScheduleMutation.mutate(selectedNote.id)}
                onDispatchNow={() => dispatchNowMutation.mutate(selectedNote.id)}
                onOpenWikiLink={handleOpenOrCreateWikiLink}
                onSendToCanvas={() => sendToCanvasMutation.mutate(selectedNote)}
                isSendingToCanvas={sendToCanvasMutation.isPending}
              />
            ) : (
              <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
                Select a note to view or edit it.
              </div>
            )}
          </div>
        </div>
      )}

      {/* Schedule Handoff Dialog */}
      <ScheduleNoteHandoffDialog
        open={scheduleDialogNote !== null}
        onOpenChange={(open) => {
          if (!open) setScheduleDialogNote(null);
        }}
        companyId={selectedCompanyId}
        note={scheduleDialogNote}
        agents={agents}
        projects={projects}
      />
    </div>
  );
}

interface NoteEditorPaneProps {
  note: PersonalNote;
  allNotes: PersonalNote[];
  agents: Agent[];
  projects: Project[];
  agentById: Map<string, Agent>;
  isSaving: boolean;
  isDispatching: boolean;
  isSplitting: boolean;
  onSave: (patch: Parameters<typeof personalNotesApi.update>[2]) => void;
  onDelete: () => void;
  onGiveToAgent: () => void;
  onGiveChecklistLine: (lineText: string) => void;
  onSplitChecklist: (
    items: string[],
    agentId: string | null,
    priority: "low" | "medium" | "high" | "critical",
  ) => void;
  onOpenSchedule: () => void;
  onCancelSchedule: () => void;
  onDispatchNow: () => void;
  onOpenWikiLink: (title: string) => void;
  onSendToCanvas: () => void;
  isSendingToCanvas: boolean;
}

function NoteEditorPane({
  note,
  allNotes,
  agents,
  projects,
  agentById,
  isSaving,
  isDispatching,
  isSplitting,
  onSave,
  onDelete,
  onGiveToAgent,
  onGiveChecklistLine,
  onSplitChecklist,
  onOpenSchedule,
  onCancelSchedule,
  onDispatchNow,
  onOpenWikiLink,
  onSendToCanvas,
  isSendingToCanvas,
}: NoteEditorPaneProps) {
  const [title, setTitle] = useState(note.title);
  const [body, setBody] = useState(note.body);
  const [previousBodyBeforeBrief, setPreviousBodyBeforeBrief] = useState<string | null>(null);
  const [tagDraft, setTagDraft] = useState("");
  const [previewMode, setPreviewMode] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [dirty, setDirty] = useState(false);

  // Split checklist drawer state
  const [showSplitPanel, setShowSplitPanel] = useState(false);
  const [splitAgentId, setSplitAgentId] = useState("");
  const [splitPriority, setSplitPriority] = useState<"low" | "medium" | "high" | "critical">("medium");

  // Slash command & Wiki-link picker state
  const [slashQuery, setSlashQuery] = useState<string | null>(null);
  const [slashIndex, setSlashIndex] = useState(0);
  const [wikiPickerOpen, setWikiPickerOpen] = useState(false);
  const [wikiQuery, setWikiQuery] = useState("");

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const voice = useVoiceDictation((transcript) => {
    setBody((prev) => {
      const next = prev.trim() ? `${prev.trimEnd()}\n${transcript}` : transcript;
      return next;
    });
    setDirty(true);
  });

  useEffect(() => {
    setTitle(note.title);
    setBody(note.body);
    setPreviousBodyBeforeBrief(null);
    setDirty(false);
    setShowSplitPanel(false);
    setSlashQuery(null);
    setWikiPickerOpen(false);
  }, [note.id]);

  useEffect(() => {
    if (!dirty) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      if (title.trim()) {
        onSave({ title: title.trim(), body });
        setDirty(false);
      }
    }, 650);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [title, body, dirty]);

  function flushSave() {
    if (!dirty || !title.trim()) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    onSave({ title: title.trim(), body });
    setDirty(false);
  }

  function handleFormatAsBrief() {
    setPreviousBodyBeforeBrief(body);
    const formatted = formatNoteAsAgentBrief(title, body, note.tags);
    setBody(formatted);
    setDirty(true);
    setPreviewMode(false);
  }

  function handleUndoBrief() {
    if (previousBodyBeforeBrief === null) return;
    setBody(previousBodyBeforeBrief);
    setPreviousBodyBeforeBrief(null);
    setDirty(true);
  }

  function handleAddTag() {
    const cleaned = tagDraft.trim().replace(/^#/, "");
    if (!cleaned) return;
    if (!note.tags.includes(cleaned) && note.tags.length < 20) {
      onSave({ tags: [...note.tags, cleaned] });
    }
    setTagDraft("");
  }

  function handleTagKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      handleAddTag();
    }
  }

  function handleBodyChange(nextValue: string, cursorPos: number) {
    setBody(nextValue);
    setDirty(true);

    // Detect active slash command at cursor (e.g. "/ch" at start of line or after space)
    const beforeCursor = nextValue.slice(0, cursorPos);
    const slashMatch = beforeCursor.match(/(?:^|\s)(\/[a-z-]*)$/i);
    if (slashMatch) {
      setSlashQuery(slashMatch[1]!.toLowerCase());
      setSlashIndex(0);
    } else {
      setSlashQuery(null);
    }
  }

  const matchingSlashCommands = useMemo(() => {
    if (slashQuery === null) return [];
    return NOTE_SLASH_COMMANDS.filter(
      (cmd) =>
        cmd.command.includes(slashQuery) ||
        cmd.label.toLowerCase().includes(slashQuery.slice(1)),
    );
  }, [slashQuery]);

  function executeSlashCommand(cmd: NoteSlashCommand) {
    const textarea = textareaRef.current;
    const cursor = textarea?.selectionStart ?? body.length;
    const before = body.slice(0, cursor);
    const after = body.slice(cursor);
    const strippedBefore = before.replace(/(\/[a-z-]*)$/i, "");
    setSlashQuery(null);

    if (cmd.action === "give") {
      setBody(strippedBefore + after);
      setDirty(true);
      onGiveToAgent();
      return;
    }
    if (cmd.action === "schedule") {
      setBody(strippedBefore + after);
      setDirty(true);
      onOpenSchedule();
      return;
    }
    if (cmd.action === "format-brief") {
      setBody(strippedBefore + after);
      setPreviousBodyBeforeBrief(strippedBefore + after);
      const formatted = formatNoteAsAgentBrief(title, strippedBefore + after, note.tags);
      setBody(formatted);
      setDirty(true);
      return;
    }
    if (cmd.action === "wiki-link") {
      setBody(strippedBefore + after);
      setDirty(true);
      setWikiQuery("");
      setWikiPickerOpen(true);
      return;
    }
    if (cmd.insertText) {
      const next = `${strippedBefore}${cmd.insertText}${after}`;
      setBody(next);
      setDirty(true);
      requestAnimationFrame(() => {
        if (textarea) {
          const pos = strippedBefore.length + cmd.insertText!.length;
          textarea.focus();
          textarea.setSelectionRange(pos, pos);
        }
      });
    }
  }

  function handleBodyKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (slashQuery !== null && matchingSlashCommands.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSlashIndex((i) => (i + 1) % matchingSlashCommands.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSlashIndex((i) => (i - 1 + matchingSlashCommands.length) % matchingSlashCommands.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        executeSlashCommand(matchingSlashCommands[slashIndex] ?? matchingSlashCommands[0]!);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setSlashQuery(null);
        return;
      }
    }
  }

  function insertWikiLink(targetTitle: string) {
    const token = `[[${targetTitle}]]`;
    setBody((prev) => (prev.trim() ? `${prev.trimEnd()} ${token} ` : `${token} `));
    setDirty(true);
    setWikiPickerOpen(false);
    setWikiQuery("");
  }

  const checklistItems = useMemo(() => parseChecklistItems(body), [body]);
  const uncheckedItems = useMemo(
    () => checklistItems.filter((item) => !item.checked),
    [checklistItems],
  );
  const completedCount = checklistItems.length - uncheckedItems.length;

  const linkedTaskByLine = useMemo(() => {
    const map = new Map<string, PersonalNoteLinkedTask>();
    for (const task of note.linkedTasks ?? []) {
      if (task.sourceLine) {
        map.set(task.sourceLine.trim().toLowerCase(), task);
      }
    }
    return map;
  }, [note.linkedTasks]);

  const outgoingWikiLinks = useMemo(() => extractWikiLinks(body), [body]);
  const backlinks = useMemo(() => findBacklinks(note, allNotes), [note, allNotes]);
  const otherNotesForPicker = useMemo(() => {
    const q = wikiQuery.trim().toLowerCase();
    return allNotes
      .filter((n) => n.id !== note.id && !n.archived)
      .filter((n) => !q || n.title.toLowerCase().includes(q))
      .slice(0, 8);
  }, [allNotes, note.id, wikiQuery]);

  const selectableAgents = useMemo(
    () => agents.filter((a) => a.status !== "terminated"),
    [agents],
  );

  const scheduledAgent = note.scheduledAgentId ? agentById.get(note.scheduledAgentId) : null;
  const recurrenceLabel = RECURRENCE_LABELS[note.scheduledRecurrence ?? "none"];

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col">
      {/* Top Action & Handoff Bar */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-card/50 px-3 py-2.5 md:px-5">
        <div className="flex flex-wrap items-center gap-1.5">
          <Button type="button" size="sm" onClick={onGiveToAgent}>
            <Send className="size-3.5" />
            Give to agent
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={onOpenSchedule}>
            <CalendarClock className="size-3.5 text-amber-500" />
            {note.scheduledStatus === "pending" ? "Reschedule" : "Schedule for agent"}
          </Button>

          {previousBodyBeforeBrief !== null ? (
            <Button type="button" size="sm" variant="secondary" onClick={handleUndoBrief}>
              <Undo2 className="size-3.5" />
              Undo brief
            </Button>
          ) : (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              title="Structure rough bullets into Goal / Context / Deliverables / Done Criteria"
              onClick={handleFormatAsBrief}
            >
              <Wand2 className="size-3.5 text-violet-500" />
              Format as brief
            </Button>
          )}

          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={isSendingToCanvas}
            onClick={onSendToCanvas}
            title="Place this note onto your Planning Canvas board"
          >
            <LayoutGrid className="size-3.5 text-blue-500" />
            {isSendingToCanvas ? "Placing…" : "Send to Canvas"}
          </Button>

          {voice.supported ? (
            <Button
              type="button"
              size="sm"
              variant={voice.listening ? "destructive" : "ghost"}
              onClick={voice.toggle}
              title={voice.listening ? "Stop voice dictation" : "Dictate into note"}
            >
              {voice.listening ? <MicOff className="size-3.5 animate-pulse" /> : <Mic className="size-3.5" />}
              {voice.listening ? "Stop" : "Dictate"}
            </Button>
          ) : null}
        </div>

        <div className="flex items-center gap-1">
          <span className="mr-2 text-[11px] text-muted-foreground">
            {isSaving ? (
              "Saving…"
            ) : dirty ? (
              "Unsaved changes"
            ) : (
              <span className="inline-flex items-center gap-1">
                <Check className="size-3 text-emerald-500" />
                Saved
              </span>
            )}
          </span>

          <Button
            type="button"
            variant={note.pinned ? "secondary" : "ghost"}
            size="icon-sm"
            aria-label={note.pinned ? "Unpin note" : "Pin note"}
            title={note.pinned ? "Unpin" : "Pin"}
            onClick={() => onSave({ pinned: !note.pinned })}
          >
            <Pin className={cn("size-3.5", note.pinned && "fill-current text-amber-500")} />
          </Button>

          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={note.archived ? "Unarchive note" : "Archive note"}
            title={note.archived ? "Unarchive" : "Archive"}
            onClick={() => onSave({ archived: !note.archived })}
          >
            {note.archived ? <ArchiveRestore className="size-3.5" /> : <Archive className="size-3.5" />}
          </Button>

          {confirmDelete ? (
            <div className="flex items-center gap-1 rounded-md border border-destructive/40 bg-destructive/10 px-2 py-0.5">
              <span className="text-[11px] font-medium text-destructive">Delete?</span>
              <button
                type="button"
                onClick={onDelete}
                className="rounded bg-destructive px-1.5 py-0.5 text-[11px] font-medium text-destructive-foreground"
              >
                Yes
              </button>
              <button
                type="button"
                onClick={() => setConfirmDelete(false)}
                className="rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:text-foreground"
              >
                No
              </button>
            </div>
          ) : (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Delete note"
              title="Delete note"
              onClick={() => setConfirmDelete(true)}
            >
              <Trash2 className="size-3.5 text-muted-foreground hover:text-destructive" />
            </Button>
          )}
        </div>
      </div>

      {/* Live Voice Banner */}
      {voice.listening || voice.error ? (
        <div
          className={cn(
            "flex items-center justify-between gap-2 border-b px-5 py-2 text-xs",
            voice.error
              ? "border-destructive/30 bg-destructive/10 text-destructive"
              : "border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300",
          )}
        >
          <div className="flex items-center gap-2 truncate">
            {!voice.error ? <span className="size-2 animate-pulse rounded-full bg-rose-500" /> : null}
            <span className="truncate">
              {voice.error
                ? voice.error
                : voice.interim
                  ? `Listening: “${voice.interim}”`
                  : "Listening… speak naturally to dictate into your note."}
            </span>
          </div>
          {voice.listening ? (
            <Button type="button" size="xs" variant="ghost" onClick={voice.stop}>
              Stop
            </Button>
          ) : null}
        </div>
      ) : null}

      {/* Scheduled Handoff Banner */}
      {note.scheduledStatus === "pending" && note.scheduledFor ? (
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-amber-500/30 bg-amber-500/10 px-3 py-2.5 md:px-5 text-xs">
          <div className="flex items-center gap-2 text-amber-800 dark:text-amber-200">
            <Clock className="size-4 shrink-0" />
            <div>
              <span className="font-semibold">Scheduled for {formatShortDateTime(note.scheduledFor)}</span>
              {recurrenceLabel ? (
                <span className="ml-1.5 inline-flex items-center gap-0.5 rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-semibold">
                  <Repeat className="size-2.5" />
                  {recurrenceLabel}
                </span>
              ) : null}
              {scheduledAgent ? <span> · Agent: <strong>{scheduledAgent.name}</strong></span> : <span> · Unassigned</span>}
              {note.scheduledInstructions ? (
                <p className="mt-0.5 line-clamp-1 text-[11px] opacity-85">
                  Instructions: {note.scheduledInstructions}
                </p>
              ) : null}
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <Button
              type="button"
              size="xs"
              variant="secondary"
              disabled={isDispatching}
              onClick={onDispatchNow}
            >
              <Send className="size-3" />
              {isDispatching ? "Sending…" : "Send now"}
            </Button>
            <Button type="button" size="xs" variant="ghost" onClick={onOpenSchedule}>
              Edit
            </Button>
            <Button type="button" size="xs" variant="ghost" onClick={onCancelSchedule}>
              Cancel
            </Button>
          </div>
        </div>
      ) : note.scheduledStatus === "failed" ? (
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-destructive/30 bg-destructive/10 px-3 py-2.5 md:px-5 text-xs text-destructive">
          <div className="flex items-center gap-2">
            <AlertTriangle className="size-4 shrink-0" />
            <span>
              Scheduled handoff failed{note.scheduledError ? `: ${note.scheduledError}` : "."}
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <Button type="button" size="xs" variant="secondary" onClick={onOpenSchedule}>
              Reschedule
            </Button>
            <Button type="button" size="xs" variant="ghost" onClick={onCancelSchedule}>
              Dismiss
            </Button>
          </div>
        </div>
      ) : null}

      {/* Editor Body */}
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-3 py-4 md:px-6 md:py-5">
        <input
          type="text"
          value={title}
          onChange={(e) => {
            setTitle(e.target.value);
            setDirty(true);
          }}
          onBlur={flushSave}
          placeholder="Untitled note"
          className="w-full bg-transparent text-xl font-bold md:text-2xl tracking-tight text-foreground placeholder:text-muted-foreground/50 outline-none"
        />

        {/* Metadata bar */}
        <div className="flex flex-wrap items-center gap-3 border-b border-border/70 pb-3 text-xs">
          <div className="flex items-center gap-1.5" role="radiogroup" aria-label="Note color">
            {PERSONAL_NOTE_COLORS.map((swatch) => {
              const style = NOTE_COLOR_STYLES[swatch];
              const active = note.color === swatch;
              return (
                <button
                  key={swatch}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  aria-label={style.label}
                  title={style.label}
                  onClick={() => onSave({ color: swatch as PersonalNoteColor })}
                  className={cn(
                    "size-3.5 rounded-full transition-transform",
                    style.dot,
                    active ? "scale-110 ring-2 ring-foreground/60 ring-offset-2 ring-offset-background" : "opacity-60 hover:opacity-100",
                  )}
                />
              );
            })}
          </div>

          <span className="text-border">|</span>

          <div className="inline-flex items-center gap-1.5">
            <FolderOpen className="size-3.5 text-muted-foreground" />
            <OptionSelect
              ariaLabel="Linked project"
              value={note.projectId ?? ""}
              items={projects.map((p) => ({ value: p.id, label: p.name }))}
              emptyLabel="No project"
              placeholder="No project"
              searchPlaceholder="Search projects…"
              onChange={(next) => onSave({ projectId: next || null })}
              triggerClassName="h-auto border-0 bg-transparent px-1 py-0 text-xs font-normal shadow-none"
            />
          </div>

          <span className="text-border">|</span>

          <div className="inline-flex rounded-md border border-border bg-muted/40 p-0.5">
            <button
              type="button"
              onClick={() => setPreviewMode(false)}
              className={cn(
                "inline-flex items-center gap-1 rounded px-2 py-0.5 text-[11px] transition-colors",
                !previewMode ? "bg-background font-medium text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground",
              )}
            >
              <Pencil className="size-3" />
              Write
            </button>
            <button
              type="button"
              onClick={() => setPreviewMode(true)}
              className={cn(
                "inline-flex items-center gap-1 rounded px-2 py-0.5 text-[11px] transition-colors",
                previewMode ? "bg-background font-medium text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground",
              )}
            >
              <Eye className="size-3" />
              Preview
            </button>
          </div>

          <button
            type="button"
            onClick={() => setWikiPickerOpen((v) => !v)}
            className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 py-0.5 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
            title="Insert [[Wiki Link]] to another note"
          >
            <Link2 className="size-3" />
            Link note
          </button>

          <span className="ml-auto hidden text-[11px] text-muted-foreground/70 lg:inline">
            Type <kbd className="rounded border border-border px-1 font-mono text-[10px]">/</kbd> for commands
          </span>
        </div>

        {/* Wiki Link Picker Popover Bar */}
        {wikiPickerOpen ? (
          <div className="flex flex-col gap-2 rounded-lg border border-border bg-muted/30 p-3 text-xs">
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium text-foreground">Insert [[Wiki Link]]</span>
              <button
                type="button"
                onClick={() => setWikiPickerOpen(false)}
                className="text-muted-foreground hover:text-foreground"
              >
                <X className="size-3.5" />
              </button>
            </div>
            <input
              type="text"
              autoFocus
              value={wikiQuery}
              onChange={(e) => setWikiQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && wikiQuery.trim()) {
                  e.preventDefault();
                  insertWikiLink(wikiQuery.trim());
                } else if (e.key === "Escape") {
                  setWikiPickerOpen(false);
                }
              }}
              placeholder="Search existing note or type a new note title + Enter…"
              className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-xs text-foreground outline-none focus:border-ring"
            />
            <div className="flex flex-wrap gap-1.5">
              {otherNotesForPicker.map((n) => (
                <button
                  key={n.id}
                  type="button"
                  onClick={() => insertWikiLink(n.title)}
                  className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground hover:bg-accent"
                >
                  <Link2 className="size-3 text-muted-foreground" />
                  {n.title}
                </button>
              ))}
              {wikiQuery.trim() ? (
                <button
                  type="button"
                  onClick={() => insertWikiLink(wikiQuery.trim())}
                  className="inline-flex items-center gap-1 rounded-md bg-foreground px-2 py-1 text-xs font-medium text-background"
                >
                  <Plus className="size-3" />
                  Link “{wikiQuery.trim()}”
                </button>
              ) : null}
            </div>
          </div>
        ) : null}

        {/* Tags row */}
        <div className="flex flex-wrap items-center gap-1.5">
          <Tag className="size-3.5 text-muted-foreground" />
          {note.tags.map((tag) => (
            <span
              key={tag}
              className="inline-flex items-center gap-1 rounded-full bg-secondary px-2 py-0.5 text-xs text-secondary-foreground"
            >
              #{tag}
              <button
                type="button"
                aria-label={`Remove tag ${tag}`}
                onClick={() => onSave({ tags: note.tags.filter((t) => t !== tag) })}
                className="text-muted-foreground hover:text-foreground"
              >
                <X className="size-2.5" />
              </button>
            </span>
          ))}
          <input
            type="text"
            value={tagDraft}
            onChange={(e) => setTagDraft(e.target.value)}
            onKeyDown={handleTagKeyDown}
            onBlur={handleAddTag}
            placeholder="Add tag…"
            className="w-24 bg-transparent text-xs text-foreground placeholder:text-muted-foreground/60 outline-none"
          />
        </div>

        {/* Interactive Checklist Delegation Panel */}
        {checklistItems.length > 0 ? (
          <div className="rounded-xl border border-border bg-muted/20 p-3.5">
            <div className="flex flex-wrap items-center justify-between gap-2 pb-2">
              <div className="flex items-center gap-2">
                <ListChecks className="size-4 text-foreground/80" />
                <span className="text-xs font-semibold text-foreground">
                  Action Items ({completedCount}/{checklistItems.length})
                </span>
                <div className="h-1.5 w-20 overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-emerald-500 transition-all"
                    style={{
                      width: `${Math.round((completedCount / checklistItems.length) * 100)}%`,
                    }}
                  />
                </div>
              </div>

              {uncheckedItems.length > 0 ? (
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  onClick={() => setShowSplitPanel((v) => !v)}
                >
                  <Split className="size-3" />
                  Delegate all unchecked ({uncheckedItems.length})
                </Button>
              ) : null}
            </div>

            {showSplitPanel && uncheckedItems.length > 0 ? (
              <div className="mb-2.5 flex flex-wrap items-center gap-2 rounded-lg border border-border bg-background p-2.5 text-xs">
                <span className="font-medium text-foreground">
                  Create {uncheckedItems.length} {uncheckedItems.length === 1 ? "task" : "tasks"}:
                </span>
                <AgentPicker
                  ariaLabel="Agent for delegated tasks"
                  agents={selectableAgents}
                  value={splitAgentId}
                  onChange={setSplitAgentId}
                  emptyLabel="Unassigned"
                  placeholder="Unassigned"
                  className="w-56"
                  compact
                />
                <OptionSelect
                  ariaLabel="Priority for delegated tasks"
                  placeholder="Priority"
                  triggerClassName="h-auto py-1 text-xs font-normal"
                  value={splitPriority}
                  items={[
                    { value: "low", label: "Low" },
                    { value: "medium", label: "Medium" },
                    { value: "high", label: "High" },
                    { value: "critical", label: "Critical" },
                  ]}
                  onChange={(next) => setSplitPriority(next as "low" | "medium" | "high" | "critical")}
                />
                <Button
                  type="button"
                  size="xs"
                  disabled={isSplitting}
                  onClick={() => {
                    onSplitChecklist(
                      uncheckedItems.map((i) => i.text),
                      splitAgentId || null,
                      splitPriority,
                    );
                    setShowSplitPanel(false);
                  }}
                >
                  <Send className="size-3" />
                  {isSplitting ? "Creating…" : "Dispatch all"}
                </Button>
                <Button type="button" size="xs" variant="ghost" onClick={() => setShowSplitPanel(false)}>
                  Cancel
                </Button>
              </div>
            ) : null}

            <div className="flex flex-col gap-1.5">
              {checklistItems.map((item) => {
                const linked = linkedTaskByLine.get(item.text.trim().toLowerCase());
                return (
                  <div
                    key={`${item.lineIndex}:${item.text}`}
                    className="group/chk flex items-center justify-between gap-2 rounded-md px-1.5 py-1 hover:bg-background/70"
                  >
                    <button
                      type="button"
                      onClick={() => {
                        const nextBody = toggleChecklistLine(body, item.lineIndex);
                        setBody(nextBody);
                        onSave({ title: title.trim() || note.title, body: nextBody });
                        setDirty(false);
                      }}
                      className="flex min-w-0 flex-1 items-center gap-2 text-left text-xs"
                    >
                      {item.checked ? (
                        <CheckSquare className="size-3.5 shrink-0 text-emerald-500" />
                      ) : (
                        <Square className="size-3.5 shrink-0 text-muted-foreground" />
                      )}
                      <span
                        className={cn(
                          "truncate",
                          item.checked ? "text-muted-foreground line-through" : "text-foreground",
                        )}
                      >
                        {item.text}
                      </span>
                    </button>

                    {linked ? (
                      <Link
                        to={`/issues/${linked.issueIdentifier ?? linked.issueId}`}
                        className={cn(
                          "inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium hover:underline",
                          issueStatusTone(linked.issueStatus),
                        )}
                      >
                        {linked.issueIdentifier ?? "Task"}
                        <span className="opacity-75">· {linked.issueStatus ?? "open"}</span>
                        <ArrowUpRight className="size-2.5" />
                      </Link>
                    ) : !item.checked ? (
                      <button
                        type="button"
                        onClick={() => onGiveChecklistLine(item.text)}
                        className="inline-flex shrink-0 items-center gap-1 rounded border border-border bg-background px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground opacity-0 transition-opacity group-hover/chk:opacity-100 hover:border-foreground/30 hover:text-foreground focus-visible:opacity-100"
                      >
                        <Send className="size-2.5" />
                        Give to agent
                      </button>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </div>
        ) : null}

        {/* Slash command floating menu */}
        {slashQuery !== null && matchingSlashCommands.length > 0 && !previewMode ? (
          <div className="rounded-lg border border-border bg-popover p-1 shadow-md">
            <div className="px-2 py-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              Slash Commands
            </div>
            {matchingSlashCommands.map((cmd, idx) => (
              <button
                key={cmd.id}
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault();
                  executeSlashCommand(cmd);
                }}
                className={cn(
                  "flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors",
                  idx === slashIndex ? "bg-accent text-accent-foreground" : "hover:bg-accent/60",
                )}
              >
                <span className="flex items-center gap-2">
                  <span className="font-mono text-[11px] font-semibold text-foreground">{cmd.command}</span>
                  <span className="text-muted-foreground">{cmd.description}</span>
                </span>
              </button>
            ))}
          </div>
        ) : null}

        {/* Markdown Editor / Preview */}
        {previewMode ? (
          <div className="min-h-56 flex-1 rounded-lg border border-border/70 bg-muted/15 p-3 text-base md:p-4 md:text-sm">
            {body.trim() ? (
              <MarkdownBody>{body}</MarkdownBody>
            ) : (
              <p className="italic text-muted-foreground">Nothing written yet.</p>
            )}
          </div>
        ) : (
          <textarea
            ref={textareaRef}
            value={body}
            onChange={(e) => handleBodyChange(e.target.value, e.target.selectionStart)}
            onKeyDown={handleBodyKeyDown}
            onBlur={flushSave}
            placeholder="Write in Markdown… Type / for commands, - [ ] for delegatable action items, or [[Note Title]] to link notes."
            className="min-h-56 flex-1 resize-none bg-transparent text-base md:text-sm leading-relaxed text-foreground placeholder:text-muted-foreground/50 outline-none"
          />
        )}

        {/* Live Connections Footer: Linked Tasks + Wiki Links + Backlinks */}
        {(note.linkedTasks?.length ?? 0) > 0 ||
        outgoingWikiLinks.length > 0 ||
        backlinks.length > 0 ? (
          <div className="mt-2 flex flex-col gap-3 rounded-xl border border-border/80 bg-muted/15 p-3.5 text-xs">
            {(note.linkedTasks?.length ?? 0) > 0 ? (
              <div className="flex flex-col gap-1.5">
                <span className="font-semibold text-foreground">
                  Live Agent Tasks ({note.linkedTasks.length})
                </span>
                <div className="flex flex-wrap gap-1.5">
                  {note.linkedTasks.map((task) => {
                    const agent = task.assigneeAgentId ? agentById.get(task.assigneeAgentId) : null;
                    return (
                      <Link
                        key={task.id}
                        to={`/issues/${task.issueIdentifier ?? task.issueId}`}
                        className={cn(
                          "inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-medium hover:underline",
                          issueStatusTone(task.issueStatus),
                        )}
                      >
                        <span>{task.issueIdentifier ?? "Task"}</span>
                        <span className="max-w-44 truncate font-normal">
                          {task.issueTitle ?? task.sourceLine ?? ""}
                        </span>
                        {agent ? <span className="opacity-75">· {agent.name}</span> : null}
                        <span className="opacity-75">· {task.issueStatus ?? "open"}</span>
                        <ExternalLink className="size-2.5" />
                      </Link>
                    );
                  })}
                </div>
              </div>
            ) : null}

            {outgoingWikiLinks.length > 0 ? (
              <div className="flex flex-col gap-1.5">
                <span className="font-semibold text-foreground">Linked Notes</span>
                <div className="flex flex-wrap gap-1.5">
                  {outgoingWikiLinks.map((targetTitle) => {
                    const exists = allNotes.some(
                      (n) => !n.archived && n.title.trim().toLowerCase() === targetTitle.toLowerCase(),
                    );
                    return (
                      <button
                        key={targetTitle}
                        type="button"
                        onClick={() => onOpenWikiLink(targetTitle)}
                        className={cn(
                          "inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] font-medium transition-colors",
                          exists
                            ? "border-border bg-background text-foreground hover:bg-accent"
                            : "border-dashed border-border bg-transparent text-muted-foreground hover:text-foreground",
                        )}
                      >
                        <Link2 className="size-3" />
                        {targetTitle}
                        {!exists ? <span className="text-[10px] opacity-70">(create)</span> : null}
                      </button>
                    );
                  })}
                </div>
              </div>
            ) : null}

            {backlinks.length > 0 ? (
              <div className="flex flex-col gap-1.5">
                <span className="font-semibold text-foreground">
                  Backlinks ({backlinks.length})
                </span>
                <div className="flex flex-wrap gap-1.5">
                  {backlinks.map((other) => (
                    <button
                      key={other.id}
                      type="button"
                      onClick={() => onOpenWikiLink(other.title)}
                      className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 py-0.5 text-[11px] text-foreground hover:bg-accent"
                    >
                      <ArrowUpRight className="size-3 text-muted-foreground" />
                      {other.title}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
