import { useQuery } from "@tanstack/react-query";
import { issuesApi } from "@/api/issues";
import { queryKeys } from "@/lib/queryKeys";
import { Link } from "@/lib/router";
import { IssueStatusBadge } from "@/components/StatusBadge";
import { useLatestCanvas } from "@/components/planning-canvas/nodes/canvas-context";

/** Subtasks listed before the rest are only counted. */
export const SUBTASK_SHOWN = 20;
/** One read holds at most this many children; a full read shows "N+ more". */
const SUBTASK_READ_LIMIT = 100;

type ArtifactLink = { key: string; label: string; kind: string; href: string };

const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();

function SectionTitle({ children }: { children: string }) {
  return <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{children}</h4>;
}

/**
 * What an issue card expands to: its subtasks and its artifacts, each a link into the issue page.
 * Mounted only while open, so nothing is read until the first open. Every read applies the
 * viewer's own issue access on the server, so view access is enough.
 */
export function IssueExpandPanel({ issueId, slug }: { issueId: string; slug: string }) {
  const companyId = useLatestCanvas().current.selectedCompanyId ?? "";
  const enabled = !!companyId;
  const subtasks = useQuery({
    queryKey: [...queryKeys.issues.list(companyId), "canvas-subtasks", issueId],
    queryFn: () => issuesApi.list(companyId, { parentIds: [issueId], projection: "rows", limit: SUBTASK_READ_LIMIT }),
    enabled,
    staleTime: 15_000,
  });
  const documents = useQuery({ queryKey: queryKeys.issues.documents(issueId), queryFn: () => issuesApi.listDocuments(issueId), enabled, staleTime: 15_000 });
  const products = useQuery({ queryKey: queryKeys.issues.workProducts(issueId), queryFn: () => issuesApi.listWorkProducts(issueId), enabled, staleTime: 15_000 });
  const attachments = useQuery({ queryKey: queryKeys.issues.attachments(issueId), queryFn: () => issuesApi.listAttachments(issueId), enabled, staleTime: 15_000 });

  const page = `/issues/${slug}`;
  const artifacts: ArtifactLink[] = [
    ...(documents.data ?? []).map((d) => ({ key: `d${d.id}`, label: d.title ?? d.key, kind: "Document", href: `${page}#document-${encodeURIComponent(d.key)}` })),
    ...(products.data ?? []).map((p) => ({ key: `w${p.id}`, label: p.title, kind: "Work product", href: page })),
    ...(attachments.data ?? []).map((a) => ({ key: `a${a.id}`, label: a.originalFilename ?? "Attachment", kind: "Attachment", href: page })),
  ];
  const artifactsLoading = documents.isPending || products.isPending || attachments.isPending;
  const artifactsFailed = documents.isError || products.isError || attachments.isError;

  const rows = subtasks.data ?? [];
  const hidden = Math.max(0, rows.length - SUBTASK_SHOWN);

  return (
    <div
      role="region"
      aria-label="Subtasks and artifacts"
      className="nodrag nopan nowheel absolute left-0 top-full z-10 mt-1 flex max-h-72 w-72 max-w-full flex-col gap-2 overflow-y-auto rounded-xl border border-border bg-popover p-3 text-popover-foreground shadow-md"
      onPointerDown={stop}
      onClick={stop}
    >
      <section className="flex flex-col gap-1">
        <SectionTitle>Subtasks</SectionTitle>
        {subtasks.isPending ? (
          <p className="text-xs text-muted-foreground">Loading…</p>
        ) : subtasks.isError ? (
          <p role="alert" className="text-xs text-destructive">Couldn't load subtasks.</p>
        ) : rows.length === 0 ? (
          <p className="text-xs text-muted-foreground">No subtasks.</p>
        ) : (
          <ul className="flex min-w-0 flex-col gap-1">
            {rows.slice(0, SUBTASK_SHOWN).map((row) => (
              <li key={row.id} className="flex min-w-0 items-center gap-2 text-xs">
                <Link to={`/issues/${row.identifier ?? row.id}`} className="shrink-0 font-semibold text-foreground hover:underline">
                  {row.identifier ?? "Issue"}
                </Link>
                <IssueStatusBadge status={row.status} />
                <span className="min-w-0 truncate text-foreground">{row.title}</span>
              </li>
            ))}
            {hidden > 0 ? (
              <li className="text-xs text-muted-foreground">
                {rows.length >= SUBTASK_READ_LIMIT ? `${hidden}+` : hidden} more
              </li>
            ) : null}
          </ul>
        )}
      </section>
      <section className="flex flex-col gap-1">
        <SectionTitle>Artifacts</SectionTitle>
        {artifactsLoading && artifacts.length === 0 && !artifactsFailed ? (
          <p className="text-xs text-muted-foreground">Loading…</p>
        ) : (
          <>
            {artifacts.length === 0 && !artifactsFailed ? <p className="text-xs text-muted-foreground">No artifacts.</p> : null}
            <ul className="flex min-w-0 flex-col gap-1">
              {artifacts.map((a) => (
                <li key={a.key} className="flex min-w-0 items-center gap-2 text-xs">
                  <span className="shrink-0 text-muted-foreground">{a.kind}</span>
                  <Link to={a.href} className="min-w-0 truncate text-foreground hover:underline">{a.label}</Link>
                </li>
              ))}
            </ul>
            {artifactsFailed ? <p role="alert" className="text-xs text-destructive">Couldn't load all artifacts.</p> : null}
          </>
        )}
      </section>
    </div>
  );
}
