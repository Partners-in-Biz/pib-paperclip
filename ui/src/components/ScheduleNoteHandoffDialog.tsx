import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { Agent, PersonalNote, PersonalNoteRecurrence, Project } from "@paperclipai/shared";
import { CalendarClock, FolderOpen, Repeat, Sparkles, UserCheck, X } from "lucide-react";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useToastActions } from "@/context/ToastContext";
import { personalNotesApi } from "@/api/personalNotes";
import { queryKeys } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";

function toLocalDateTimeInputValue(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function buildPresets(): Array<{ label: string; getDate: () => Date }> {
  return [
    {
      label: "In 1 hour",
      getDate: () => {
        const d = new Date();
        d.setHours(d.getHours() + 1);
        d.setSeconds(0, 0);
        return d;
      },
    },
    {
      label: "In 3 hours",
      getDate: () => {
        const d = new Date();
        d.setHours(d.getHours() + 3);
        d.setSeconds(0, 0);
        return d;
      },
    },
    {
      label: "Tomorrow 9:00",
      getDate: () => {
        const d = new Date();
        d.setDate(d.getDate() + 1);
        d.setHours(9, 0, 0, 0);
        return d;
      },
    },
    {
      label: "Next Mon 9:00",
      getDate: () => {
        const d = new Date();
        const day = d.getDay();
        const daysUntilMonday = ((8 - day) % 7) || 7;
        d.setDate(d.getDate() + daysUntilMonday);
        d.setHours(9, 0, 0, 0);
        return d;
      },
    },
  ];
}

export interface ScheduleNoteHandoffDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  companyId: string;
  note: PersonalNote | null;
  agents: Agent[];
  projects: Project[];
  onScheduled?: (updated: PersonalNote) => void;
}

export function ScheduleNoteHandoffDialog({
  open,
  onOpenChange,
  companyId,
  note,
  agents,
  projects,
  onScheduled,
}: ScheduleNoteHandoffDialogProps) {
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const presets = buildPresets();

  const [dateTimeLocal, setDateTimeLocal] = useState("");
  const [agentId, setAgentId] = useState("");
  const [projectId, setProjectId] = useState("");
  const [priority, setPriority] = useState<"low" | "medium" | "high" | "critical">("medium");
  const [issueStatus, setIssueStatus] = useState<"todo" | "backlog">("todo");
  const [recurrence, setRecurrence] = useState<PersonalNoteRecurrence>("none");
  const [instructions, setInstructions] = useState("");

  useEffect(() => {
    if (!open || !note) return;
    const defaultDate = note.scheduledFor
      ? new Date(note.scheduledFor)
      : presets[0]!.getDate();
    setDateTimeLocal(toLocalDateTimeInputValue(defaultDate));
    setAgentId(note.scheduledAgentId ?? "");
    setProjectId(note.scheduledProjectId ?? note.projectId ?? "");
    const p = note.scheduledPriority;
    setPriority(p === "low" || p === "high" || p === "critical" ? p : "medium");
    setIssueStatus(note.scheduledIssueStatus === "backlog" ? "backlog" : "todo");
    setRecurrence(note.scheduledRecurrence ?? "none");
    setInstructions(note.scheduledInstructions ?? "");
  }, [open, note]);

  const scheduleMutation = useMutation({
    mutationFn: async () => {
      if (!note) throw new Error("No note selected");
      const parsed = new Date(dateTimeLocal);
      if (Number.isNaN(parsed.getTime())) {
        throw new Error("Choose a valid date and time");
      }
      return personalNotesApi.scheduleHandoff(companyId, note.id, {
        scheduledFor: parsed.toISOString(),
        agentId: agentId || null,
        projectId: projectId || null,
        priority,
        issueStatus,
        instructions: instructions.trim() || null,
        recurrence,
      });
    },
    onSuccess: (updated) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.personalNotes.list(companyId) });
      onScheduled?.(updated);
      const when = updated.scheduledFor
        ? new Date(updated.scheduledFor).toLocaleString(undefined, {
            month: "short",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit",
          })
        : "";
      pushToast({
        title: "Agent handoff scheduled",
        body: when ? `Will be sent on ${when}` : updated.title,
        tone: "success",
      });
      onOpenChange(false);
    },
    onError: (error) => {
      pushToast({
        title: "Could not schedule handoff",
        body: error instanceof Error ? error.message : String(error),
        tone: "error",
      });
    },
  });

  const selectableAgents = agents.filter(
    (agent) => agent.status !== "terminated",
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="w-[calc(100vw-2rem)] max-w-lg gap-0 overflow-hidden p-0"
      >
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div className="flex items-center gap-2">
            <CalendarClock className="size-4 text-amber-500" />
            <div>
              <h2 className="text-sm font-semibold text-foreground">Schedule handoff to agent</h2>
              {note ? (
                <p className="max-w-80 truncate text-xs text-muted-foreground">{note.title}</p>
              ) : null}
            </div>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Close"
            onClick={() => onOpenChange(false)}
          >
            <X className="size-4" />
          </Button>
        </div>

        <div className="flex flex-col gap-4 px-4 py-4 text-sm">
          {/* Quick presets */}
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">Send at</span>
            <div className="flex flex-wrap gap-1.5">
              {presets.map((preset) => (
                <button
                  key={preset.label}
                  type="button"
                  onClick={() => setDateTimeLocal(toLocalDateTimeInputValue(preset.getDate()))}
                  className={cn(
                    "rounded-md border border-border bg-muted/40 px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:bg-accent",
                  )}
                >
                  {preset.label}
                </button>
              ))}
            </div>
            <div className="mt-1 grid grid-cols-1 gap-2 sm:grid-cols-2">
              <input
                type="datetime-local"
                aria-label="Schedule date and time"
                value={dateTimeLocal}
                onChange={(e) => setDateTimeLocal(e.target.value)}
                className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm text-foreground outline-none focus:border-ring"
              />
              <label className="flex items-center gap-1.5 rounded-md border border-border bg-background px-2.5 py-1.5 text-sm">
                <Repeat className="size-3.5 shrink-0 text-muted-foreground" />
                <select
                  aria-label="Recurrence"
                  value={recurrence}
                  onChange={(e) => setRecurrence(e.target.value as PersonalNoteRecurrence)}
                  className="w-full bg-transparent text-sm text-foreground outline-none"
                >
                  <option value="none">One-time</option>
                  <option value="daily">Repeat daily</option>
                  <option value="weekdays">Repeat weekdays (Mon–Fri)</option>
                  <option value="weekly">Repeat weekly</option>
                  <option value="monthly">Repeat monthly</option>
                </select>
              </label>
            </div>
          </div>

          {/* Agent & Project */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1">
              <span className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                <UserCheck className="size-3.5" />
                Agent
              </span>
              <select
                value={agentId}
                onChange={(e) => setAgentId(e.target.value)}
                className="rounded-md border border-border bg-background px-2.5 py-1.5 text-sm text-foreground outline-none focus:border-ring"
              >
                <option value="">Unassigned (triage)</option>
                {selectableAgents.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.name}
                  </option>
                ))}
              </select>
            </label>

            <label className="flex flex-col gap-1">
              <span className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                <FolderOpen className="size-3.5" />
                Project
              </span>
              <select
                value={projectId}
                onChange={(e) => setProjectId(e.target.value)}
                className="rounded-md border border-border bg-background px-2.5 py-1.5 text-sm text-foreground outline-none focus:border-ring"
              >
                <option value="">No project</option>
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {/* Priority & Initial Status */}
          <div className="grid grid-cols-2 gap-3">
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-muted-foreground">Priority</span>
              <select
                value={priority}
                onChange={(e) => setPriority(e.target.value as "low" | "medium" | "high" | "critical")}
                className="rounded-md border border-border bg-background px-2.5 py-1.5 text-sm text-foreground outline-none focus:border-ring"
              >
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
                <option value="critical">Critical</option>
              </select>
            </label>

            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-muted-foreground">Initial task status</span>
              <select
                value={issueStatus}
                onChange={(e) => setIssueStatus(e.target.value as "todo" | "backlog")}
                className="rounded-md border border-border bg-background px-2.5 py-1.5 text-sm text-foreground outline-none focus:border-ring"
              >
                <option value="todo">Todo (wake agent)</option>
                <option value="backlog">Backlog</option>
              </select>
            </label>
          </div>

          {/* Extra instructions */}
          <label className="flex flex-col gap-1">
            <span className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
              <Sparkles className="size-3.5" />
              Extra instructions for the agent (optional)
            </span>
            <textarea
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              rows={3}
              placeholder="Any specific deliverable, deadline, or context to prepend when this note becomes a task…"
              className="w-full resize-y rounded-md border border-border bg-background p-2.5 text-sm text-foreground placeholder:text-muted-foreground/60 outline-none focus:border-ring"
            />
          </label>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border bg-muted/20 px-4 py-2.5">
          <Button type="button" variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={!dateTimeLocal || scheduleMutation.isPending}
            onClick={() => scheduleMutation.mutate()}
          >
            <CalendarClock className="size-3.5" />
            {scheduleMutation.isPending ? "Scheduling…" : "Schedule handoff"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
