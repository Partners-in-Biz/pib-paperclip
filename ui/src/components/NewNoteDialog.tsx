import { useEffect, useState, type KeyboardEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PERSONAL_NOTE_COLORS, type PersonalNoteColor } from "@paperclipai/shared";
import { Eye, FolderOpen, Mic, MicOff, NotebookPen, Pencil, Pin, Sparkles, Tag, X } from "lucide-react";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useDialogActions, useDialogState } from "@/context/DialogContext";
import { useCompany } from "@/context/CompanyContext";
import { useToastActions } from "@/context/ToastContext";
import { personalNotesApi } from "@/api/personalNotes";
import { projectsApi } from "@/api/projects";
import { queryKeys } from "@/lib/queryKeys";
import { NOTE_COLOR_STYLES } from "@/lib/personal-note-colors";
import { PERSONAL_NOTE_TEMPLATES, type PersonalNoteTemplate } from "@/lib/personal-note-markdown";
import { useVoiceDictation } from "@/hooks/useVoiceDictation";
import { cn } from "@/lib/utils";
import { MarkdownBody } from "./MarkdownBody";

export function NewNoteDialog() {
  const { newNoteOpen, newNoteDefaults } = useDialogState();
  const { closeNewNote, notifyNewNoteCreated } = useDialogActions();
  const { selectedCompanyId, selectedCompany } = useCompany();
  const { pushToast } = useToastActions();
  const queryClient = useQueryClient();

  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [tagDraft, setTagDraft] = useState("");
  const [color, setColor] = useState<PersonalNoteColor>("default");
  const [pinned, setPinned] = useState(false);
  const [projectId, setProjectId] = useState<string>("");
  const [previewMode, setPreviewMode] = useState(false);

  const voice = useVoiceDictation((transcript) => {
    setBody((prev) => (prev.trim() ? `${prev.trimEnd()}\n${transcript}` : transcript));
  });

  function applyTemplate(tpl: PersonalNoteTemplate) {
    if (!title.trim()) setTitle(tpl.defaultTitle);
    setBody(tpl.body);
    setColor(tpl.color);
    setTags(Array.from(new Set([...tags, ...tpl.tags])));
    setPreviewMode(false);
  }

  const { data: projects } = useQuery({
    queryKey: queryKeys.projects.list(selectedCompanyId!),
    queryFn: () => projectsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId && newNoteOpen,
  });

  useEffect(() => {
    if (!newNoteOpen) return;
    setTitle(newNoteDefaults.title ?? "");
    setBody(newNoteDefaults.body ?? "");
    setTags(newNoteDefaults.tags ?? []);
    setTagDraft("");
    setColor(newNoteDefaults.color ?? "default");
    setPinned(newNoteDefaults.pinned ?? false);
    setProjectId(newNoteDefaults.projectId ?? "");
    setPreviewMode(false);
  }, [newNoteOpen, newNoteDefaults]);

  const createNote = useMutation({
    mutationFn: async () => {
      if (!selectedCompanyId) throw new Error("Select a company first");
      return personalNotesApi.create(selectedCompanyId, {
        title: title.trim(),
        body,
        tags,
        color,
        pinned,
        projectId: projectId || null,
        dailyDate: null,
      });
    },
    onSuccess: (created) => {
      if (selectedCompanyId) {
        queryClient.invalidateQueries({ queryKey: queryKeys.personalNotes.list(selectedCompanyId) });
      }
      notifyNewNoteCreated(created);
      pushToast({
        title: "Personal note saved",
        body: created.title,
        tone: "success",
      });
      closeNewNote();
    },
    onError: (error) => {
      pushToast({
        title: "Could not create note",
        body: error instanceof Error ? error.message : String(error),
        tone: "error",
      });
    },
  });

  function addTagFromDraft() {
    const cleaned = tagDraft.trim().replace(/^#/, "");
    if (!cleaned) return;
    if (!tags.includes(cleaned) && tags.length < 20) {
      setTags([...tags, cleaned]);
    }
    setTagDraft("");
  }

  function handleTagKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter" || event.key === ",") {
      event.preventDefault();
      addTagFromDraft();
    } else if (event.key === "Backspace" && !tagDraft && tags.length > 0) {
      setTags(tags.slice(0, -1));
    }
  }

  function handleSubmit() {
    if (!title.trim() || createNote.isPending) return;
    createNote.mutate();
  }

  function handleDialogKeyDown(event: KeyboardEvent) {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      handleSubmit();
    }
  }

  return (
    <Dialog open={newNoteOpen} onOpenChange={(open) => { if (!open) closeNewNote(); }}>
      <DialogContent
        showCloseButton={false}
        onKeyDown={handleDialogKeyDown}
        className="w-[calc(100vw-2rem)] max-w-2xl gap-0 overflow-hidden p-0"
      >
        {/* Top bar */}
        <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <NotebookPen className="size-3.5 text-foreground/80" />
            <span className="font-medium text-foreground">New personal note</span>
            {selectedCompany?.name ? (
              <span className="rounded bg-muted px-1.5 py-0.5 text-[11px]">
                {selectedCompany.name}
              </span>
            ) : null}
            <span className="text-[11px] text-muted-foreground/80">· Private to you</span>
          </div>
          <div className="flex items-center gap-1">
            <Button
              type="button"
              variant={pinned ? "secondary" : "ghost"}
              size="icon-sm"
              aria-label={pinned ? "Unpin note" : "Pin note"}
              aria-pressed={pinned}
              title={pinned ? "Pinned" : "Pin note"}
              onClick={() => setPinned((p) => !p)}
            >
              <Pin className={cn("size-3.5", pinned && "fill-current text-amber-500")} />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Close"
              onClick={closeNewNote}
            >
              <X className="size-4" />
            </Button>
          </div>
        </div>

        {/* Title + Body */}
        <div className="flex flex-col gap-3 px-4 py-3">
          <input
            type="text"
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Note title…"
            className="w-full bg-transparent text-lg font-semibold text-foreground placeholder:text-muted-foreground/60 outline-none"
          />

          {/* Quick templates */}
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="inline-flex items-center gap-1 text-[11px] font-medium text-muted-foreground">
              <Sparkles className="size-3" />
              Templates:
            </span>
            {PERSONAL_NOTE_TEMPLATES.map((tpl) => (
              <button
                key={tpl.id}
                type="button"
                title={tpl.description}
                onClick={() => applyTemplate(tpl)}
                className="rounded-full border border-border bg-muted/35 px-2 py-0.5 text-[11px] font-medium text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground"
              >
                {tpl.label}
              </button>
            ))}
          </div>

          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="inline-flex rounded-md border border-border bg-muted/40 p-0.5 text-xs">
                <button
                  type="button"
                  onClick={() => setPreviewMode(false)}
                  className={cn(
                    "inline-flex items-center gap-1 rounded px-2 py-0.5 transition-colors",
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
                    "inline-flex items-center gap-1 rounded px-2 py-0.5 transition-colors",
                    previewMode ? "bg-background font-medium text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  <Eye className="size-3" />
                  Preview
                </button>
              </div>
              {voice.supported ? (
                <button
                  type="button"
                  onClick={voice.toggle}
                  className={cn(
                    "inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-medium transition-colors",
                    voice.listening
                      ? "border-rose-500/50 bg-rose-500/15 text-rose-600 dark:text-rose-300"
                      : "border-border bg-background text-muted-foreground hover:text-foreground",
                  )}
                >
                  {voice.listening ? <MicOff className="size-3 animate-pulse" /> : <Mic className="size-3" />}
                  {voice.listening ? "Stop voice" : "Dictate"}
                </button>
              ) : null}
            </div>
            <div className="flex items-center gap-1.5" role="radiogroup" aria-label="Note color">
              {PERSONAL_NOTE_COLORS.map((swatch) => {
                const style = NOTE_COLOR_STYLES[swatch];
                const selected = color === swatch;
                return (
                  <button
                    key={swatch}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    aria-label={style.label}
                    title={style.label}
                    onClick={() => setColor(swatch)}
                    className={cn(
                      "size-4 rounded-full transition-transform",
                      style.dot,
                      selected ? "scale-110 ring-2 ring-foreground/60 ring-offset-2 ring-offset-background" : "opacity-65 hover:opacity-100",
                    )}
                  />
                );
              })}
            </div>
          </div>

          {voice.listening ? (
            <div className="flex items-center gap-2 rounded-md border border-rose-500/30 bg-rose-500/10 px-3 py-1.5 text-xs text-rose-700 dark:text-rose-300">
              <span className="size-2 animate-pulse rounded-full bg-rose-500" />
              <span className="truncate">
                {voice.interim ? `Listening: “${voice.interim}”` : "Listening… speak naturally to dictate into your note."}
              </span>
            </div>
          ) : null}

          {previewMode ? (
            <div className="min-h-44 max-h-72 overflow-y-auto rounded-lg border border-border bg-muted/20 p-3 text-sm">
              {body.trim() ? (
                <MarkdownBody>{body}</MarkdownBody>
              ) : (
                <p className="text-muted-foreground italic">Nothing to preview yet…</p>
              )}
            </div>
          ) : (
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="Write your thoughts, checklists, meeting notes, or ideas to hand off to an agent later… (Markdown supported)"
              rows={7}
              className="min-h-44 max-h-72 w-full resize-y rounded-lg border border-border bg-background/70 p-3 text-sm leading-relaxed text-foreground placeholder:text-muted-foreground/60 outline-none focus:border-ring"
            />
          )}

          {/* Tags & Project row */}
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <div className="flex min-w-44 flex-1 flex-wrap items-center gap-1 rounded-md border border-border bg-background px-2 py-1">
              <Tag className="size-3.5 shrink-0 text-muted-foreground" />
              {tags.map((tag) => (
                <span
                  key={tag}
                  className="inline-flex items-center gap-1 rounded bg-secondary px-1.5 py-0.5 text-xs text-secondary-foreground"
                >
                  #{tag}
                  <button
                    type="button"
                    aria-label={`Remove tag ${tag}`}
                    onClick={() => setTags(tags.filter((t) => t !== tag))}
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
                onBlur={addTagFromDraft}
                placeholder={tags.length === 0 ? "Add tags (Enter)…" : "Add tag…"}
                className="min-w-20 flex-1 bg-transparent text-xs text-foreground placeholder:text-muted-foreground/60 outline-none"
              />
            </div>

            <div className="flex items-center gap-1.5 rounded-md border border-border bg-background px-2 py-1 text-xs">
              <FolderOpen className="size-3.5 shrink-0 text-muted-foreground" />
              <select
                aria-label="Project"
                value={projectId}
                onChange={(e) => setProjectId(e.target.value)}
                className="bg-transparent text-xs text-foreground outline-none"
              >
                <option value="">No project</option>
                {(projects ?? []).map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between border-t border-border bg-muted/20 px-4 py-2.5">
          <span className="text-[11px] text-muted-foreground">
            Press <kbd className="rounded border border-border bg-background px-1 py-0.5 font-mono text-[10px]">⌘</kbd>+<kbd className="rounded border border-border bg-background px-1 py-0.5 font-mono text-[10px]">Enter</kbd> to save
          </span>
          <div className="flex items-center gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={closeNewNote}>
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={!title.trim() || createNote.isPending}
              onClick={handleSubmit}
            >
              {createNote.isPending ? "Saving…" : "Save note"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
