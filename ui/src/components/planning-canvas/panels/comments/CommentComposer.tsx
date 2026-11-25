import { useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { accessApi } from "@/api/access";
import { issuesApi } from "@/api/issues";
import { MarkdownEditor, type MarkdownEditorRef, type MentionOption } from "@/components/MarkdownEditor";
import { Button } from "@/components/ui/button";
import { buildMarkdownMentionOptions } from "@/lib/company-members";
import { queryKeys } from "@/lib/queryKeys";
import type { CanvasController } from "@/components/planning-canvas/state/useCanvasController";

/**
 * The comment box. `@` opens the same mention picker as the New Issue dialog (agents, people, projects,
 * issues from the recent-issue pool); an @agent mention creates or wakes a linked issue on the server.
 */
export function CommentComposer({
  c,
  busy,
  error,
  placeholder,
  onSubmit,
}: {
  c: CanvasController;
  busy: boolean;
  error: string | null;
  placeholder: string;
  onSubmit: (body: string) => Promise<void>;
}) {
  const { selectedCompanyId, agents, projects } = c;
  const [body, setBody] = useState("");
  const editor = useRef<MarkdownEditorRef>(null);

  const { data: members } = useQuery({
    queryKey: queryKeys.access.companyUserDirectory(selectedCompanyId!),
    queryFn: () => accessApi.listUserDirectory(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });
  const { data: mentionIssues } = useQuery({
    queryKey: queryKeys.issues.mentionPool(selectedCompanyId!),
    queryFn: () => issuesApi.list(selectedCompanyId!, { limit: 100, sortField: "updated", sortDir: "desc" }),
    enabled: Boolean(selectedCompanyId),
    staleTime: 60_000,
  });
  const mentions = useMemo<MentionOption[]>(
    () => buildMarkdownMentionOptions({ agents, projects, members: members?.users, issues: mentionIssues }),
    [agents, projects, members?.users, mentionIssues],
  );

  const send = async () => {
    const text = body.trim();
    if (!text || busy) return;
    try {
      await onSubmit(text);
      setBody("");
      editor.current?.clear();
    } catch {
      // The panel shows the error; the draft stays.
    }
  };

  return (
    <div className="flex flex-col gap-2 border-t border-border p-2">
      <MarkdownEditor
        ref={editor}
        value={body}
        onChange={setBody}
        mentions={mentions}
        placeholder={placeholder}
        ariaLabel="Write a comment"
        bordered
        onSubmit={() => void send()}
        submitKey="mod-enter"
        contentClassName="max-h-32 overflow-y-auto text-sm"
      />
      {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">@ to mention an agent</span>
        <Button type="button" size="sm" disabled={busy || body.trim().length === 0} onClick={() => void send()}>
          Comment
        </Button>
      </div>
    </div>
  );
}
