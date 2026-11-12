/**
 * The Previews tab: every client preview of the sprint, grouped by task, with the recorded decisions
 * (approve, decline, undo, confirm and apply). The buttons call decide-preview, undo-preview-decision and
 * confirm-preview-approval; those handlers read who you are from the signed-in session and refuse anyone else.
 */
import { useState } from "react";
import { usePluginAction } from "@paperclipai/plugin-sdk/ui";
import { Button, EmptyState, Eye, Modal, Pill, SectionCard, TextArea, breakAnywhere, tokens, useIsNarrow } from "@partnersinbiz/pib-plugin-ui";
import { Banner, IssueLink, shortUrl } from "./parts.js";
import type { PreviewItem, PreviewFilter, SprintBundle } from "./types.js";
import { PREVIEW_FILTER_LABEL, awaitingCount, previewsFor, PREVIEW_FILTERS, previewDaysLeft, previewDecider, previewExpiryTone, previewStatus } from "./words.js";

export { awaitingCount, previewsFor };

const MIN_REASON = 10;
const REVIEW_LABEL: Record<string, string> = { pending: "Reviewer: being checked", passed: "Reviewer: passed", changes_needed: "Reviewer: sent back" };

type Skipped = { id: string; reason: string };
type Reply = { skipped?: Skipped[] } | null;

export function PreviewsTab({ bundle, filter, onFilter, onChanged }: { bundle: SprintBundle; filter: PreviewFilter; onFilter: (f: PreviewFilter) => void; onChanged: () => Promise<void> }) {
  const narrow = useIsNarrow();
  const callAction = usePluginAction("seo.call");
  const sprintId = bundle.sprint.sprintId;
  const manual = bundle.sprint.clientSignoff !== "auto";
  const all = bundle.previews ?? [];
  const rows = previewsFor(all, filter);
  const [busy, setBusy] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [declining, setDeclining] = useState<PreviewItem[] | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const drawerItem = openId ? all.find((p) => p.id === openId) ?? null : null;
  const actionsFor = (p: PreviewItem) => ({
    onApprove: () => void run(p.id, [p.id], "decide-preview", { decision: "approved" }),
    onDecline: () => setDeclining([p]),
    onUndo: () => void run(p.id, [p.id], "undo-preview-decision"),
    onConfirm: () => void run(p.id, [p.id], "confirm-preview-approval"),
  });

  const run = async (key: string, ids: string[], tool: string, extra: Record<string, unknown> = {}): Promise<boolean> => {
    setBusy(key);
    setErrors((e) => Object.fromEntries(Object.entries(e).filter(([id]) => !ids.includes(id))));
    try {
      const reply = (await callAction({ tool, params: { sprintId, previewIds: ids, ...extra } })) as Reply;
      const skipped = reply?.skipped ?? [];
      if (skipped.length > 0) setErrors((e) => ({ ...e, ...Object.fromEntries(skipped.map((s) => [s.id, s.reason])) }));
      await onChanged();
      return skipped.length === 0;
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      setErrors((e) => ({ ...e, ...Object.fromEntries(ids.map((id) => [id, text])) }));
      return false;
    } finally {
      setBusy(null);
    }
  };

  // Group by task, newest group first (rows are already newest first).
  const groups: Array<{ key: string; issueId: string | null; issueIdentifier: string | null; items: PreviewItem[] }> = [];
  for (const p of rows) {
    const key = p.taskId ?? `page:${p.pageUrl}`;
    const g = groups.find((x) => x.key === key);
    if (g) g.items.push(p);
    else groups.push({ key, issueId: p.issueId, issueIdentifier: p.issueIdentifier, items: [p] });
  }

  return (
    <div style={{ display: "grid", gap: 12, minWidth: 0 }}>
      <div role="tablist" aria-label="Preview filter" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {PREVIEW_FILTERS.map((f) => (
          <Button key={f} type="button" variant={f === filter ? "primary" : "secondary"} aria-pressed={f === filter} onClick={() => onFilter(f)}>
            {PREVIEW_FILTER_LABEL[f]} ({previewsFor(all, f).length})
          </Button>
        ))}
      </div>
      {groups.length === 0 ? (
        <EmptyState icon={Eye} title={`Nothing ${PREVIEW_FILTER_LABEL[filter].toLowerCase()}`} description="Previews the SEO agent makes for this sprint show here, with the Reviewer's result." />
      ) : null}
      {groups.map((g) => {
        const open = g.items.filter((p) => p.status === "pending" && !p.expired);
        const approvable = open.filter((p) => p.reviewStatus === "passed");
        return (
          <SectionCard key={g.key} title={g.issueIdentifier ?? (g.issueId ? "Task issue" : "No task")} subtitle={`${g.items.length} preview${g.items.length === 1 ? "" : "s"}`}>
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", justifyContent: "space-between", marginBottom: 8 }}>
              <span style={{ fontSize: 13 }}>{g.issueId ? <IssueLink id={g.issueId} identifier={g.issueIdentifier} /> : "No issue yet"}</span>
              {open.length > 0 ? (
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <Button type="button" variant="secondary" disabled={busy !== null || approvable.length === 0} title={approvable.length === 0 ? "None of these has passed the Reviewer yet" : `Approve ${approvable.length} passed preview${approvable.length === 1 ? "" : "s"}`} onClick={() => void run(`all-${g.key}`, approvable.map((p) => p.id), "decide-preview", { decision: "approved" })}>Approve all</Button>
                  <Button type="button" variant="secondary" disabled={busy !== null} onClick={() => setDeclining(open)}>Decline all</Button>
                </div>
              ) : null}
            </div>
            <div style={{ display: "grid", gap: 0, minWidth: 0 }}>
              {g.items.map((p) => (
                <PreviewRow key={p.id} p={p} manual={manual} narrow={narrow} busy={busy} error={errors[p.id]} onOpen={() => setOpenId(p.id)} {...actionsFor(p)} />
              ))}
            </div>
          </SectionCard>
        );
      })}
      {drawerItem ? <PreviewDrawer p={drawerItem} manual={manual} narrow={narrow} busy={busy} error={errors[drawerItem.id]} onClose={() => setOpenId(null)} {...actionsFor(drawerItem)} /> : null}
      {declining ? <DeclineModal items={declining} onClose={() => setDeclining(null)} onSubmit={async (note) => { const ok = await run("decline", declining.map((p) => p.id), "decide-preview", { decision: "declined", note }); if (ok) setDeclining(null); return ok; }} errors={errors} /> : null}
    </div>
  );
}

function PreviewRow({ p, manual, narrow, busy, error, now = Date.now(), onOpen, onApprove, onDecline, onUndo, onConfirm }: {
  p: PreviewItem; manual: boolean; narrow: boolean; busy: string | null; error?: string; now?: number;
  onOpen: () => void; onApprove: () => void; onDecline: () => void; onUndo: () => void; onConfirm: () => void;
}) {
  const status = previewStatus(p);
  const left = previewDaysLeft(p.expiresAt, now);
  const open = p.status === "pending" && !p.expired;
  const decided = p.status === "approved" || p.status === "declined" || p.status === "changes_requested";
  return (
    <div style={{ display: "grid", gap: 6, padding: "10px 0", borderTop: `1px solid ${tokens.border}`, minWidth: 0 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", minWidth: 0 }}>
        <button type="button" onClick={onOpen} aria-label={`Open preview of ${shortUrl(p.pageUrl)}`} title="Open the preview details" style={{ all: "unset", cursor: "pointer", fontSize: 13, fontWeight: 700, textDecoration: "underline", ...breakAnywhere }}>{shortUrl(p.pageUrl)}</button>
        <Pill tone={status.tone} dot>{status.label}</Pill>
      </div>
      <span style={{ fontSize: 12, color: tokens.muted, ...breakAnywhere }}>
        {p.changedFields.length > 0 ? `Changes: ${p.changedFields.join(", ")}` : "Changes: none listed"} · {REVIEW_LABEL[p.reviewStatus] ?? p.reviewStatus}
        {p.reviewNote ? ` (${p.reviewNote})` : ""}
      </span>
      {open ? <span style={{ fontSize: 12, color: tokens.tones[previewExpiryTone(left)].fg }}>{left <= 0 ? "Expires today" : `${left} day${left === 1 ? "" : "s"} to expiry`}</span> : null}
      {decided ? <span style={{ fontSize: 12, color: tokens.muted, ...breakAnywhere }}>{previewDecider(p)}{p.decisionNote ? ` · "${p.decisionNote}"` : ""}</span> : null}
      {p.overlapIds.length > 0 ? <span style={{ fontSize: 12, color: tokens.muted }}>{p.overlapIds.length} other pending preview{p.overlapIds.length === 1 ? "" : "s"} for this page.</span> : null}
      {p.expired ? <span style={{ fontSize: 12 }}>Expired before a decision. {p.issueId ? <IssueLink id={p.issueId} identifier={p.issueIdentifier} /> : null}</span> : null}
      {error ? <Banner tone="bad">{error}</Banner> : null}
      <PreviewActions p={p} manual={manual} narrow={narrow} busy={busy} onApprove={onApprove} onDecline={onDecline} onUndo={onUndo} onConfirm={onConfirm} />
    </div>
  );
}

type ActionProps = { p: PreviewItem; manual: boolean; narrow: boolean; busy: string | null; onApprove: () => void; onDecline: () => void; onUndo: () => void; onConfirm: () => void };

/** The decision buttons, the same in the row and in the drawer. */
function PreviewActions({ p, manual, narrow, busy, onApprove, onDecline, onUndo, onConfirm }: ActionProps) {
  const open = p.status === "pending" && !p.expired;
  const decided = p.status === "approved" || p.status === "declined" || p.status === "changes_requested";
  const clientApproved = p.status === "approved" && p.decisionSource === "email" && !p.confirmedAt;
  const reason = p.reviewStatus === "passed" ? "" : "The Reviewer has not passed this preview yet";
  const disabled = busy !== null;
  if (!open && !(decided && !p.appliedAt)) return null;
  return (
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", flexDirection: narrow ? "column" : "row" }}>
          {open ? (
            <>
              <Button type="button" variant="primary" disabled={disabled || Boolean(reason)} title={reason || "Approve this preview"} onClick={onApprove}>Approve</Button>
              {reason ? <span style={{ fontSize: 12, color: tokens.muted, alignSelf: "center" }}>{reason}</span> : null}
              <Button type="button" variant="secondary" disabled={disabled} onClick={onDecline}>Decline</Button>
            </>
          ) : null}
          {decided && !p.appliedAt ? <Button type="button" variant="secondary" disabled={disabled} onClick={onUndo}>Undo</Button> : null}
          {clientApproved && manual ? <Button type="button" variant="primary" disabled={disabled} onClick={onConfirm}>Confirm and apply</Button> : null}
        </div>
      
  );
}

function Field({ label, value }: { label: string; value: string | null }) {
  return (
    <div style={{ display: "grid", gap: 2, minWidth: 0 }}>
      <span style={{ fontSize: 12, color: tokens.muted }}>{label}</span>
      <span style={{ fontSize: 13, ...breakAnywhere }}>{value ?? "Not changed"}</span>
    </div>
  );
}

const BODY_MODE_LABEL: Record<string, string> = { before: "Added above the existing content", after: "Added below the existing content", replace: "Replaces the whole content area" };

/** One preview in full: the links (built by the server), the proposed copy, the evidence and the same decision buttons. No live fetch. */
function PreviewDrawer({ p, onClose, error, ...actions }: ActionProps & { error?: string; onClose: () => void }) {
  const status = previewStatus(p);
  const linkStyle = { fontSize: 13, color: tokens.fg, fontWeight: 600 } as const;
  return (
    <Modal open title={shortUrl(p.pageUrl)} description={p.title} onClose={onClose} width={560} footer={<Button type="button" variant="secondary" onClick={onClose}>Close</Button>}>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
        <Pill tone={status.tone} dot>{status.label}</Pill>
        <a href={p.url} target="_blank" rel="noreferrer" style={linkStyle}>Proposal ↗</a>
        {p.reviewUrl ? <a href={p.reviewUrl} target="_blank" rel="noreferrer" style={linkStyle}>Live vs proposal ↗</a> : null}
      </div>
      <div style={{ display: "grid", gap: 8 }}>
        <strong style={{ fontSize: 13 }}>Proposed copy</strong>
        <Field label="Title" value={p.changes.title} />
        <Field label="Meta description" value={p.changes.metaDescription} />
        <Field label="Heading (H1)" value={p.changes.h1} />
        <Field label="Body copy" value={p.changes.bodyMode ? BODY_MODE_LABEL[p.changes.bodyMode] ?? p.changes.bodyMode : null} />
      </div>
      <div style={{ display: "grid", gap: 8 }}>
        <strong style={{ fontSize: 13 }}>Evidence</strong>
        <Field label="Reviewer" value={`${REVIEW_LABEL[p.reviewStatus]?.replace("Reviewer: ", "") ?? p.reviewStatus}${p.reviewNote ? `: ${p.reviewNote}` : ""}`} />
        <Field label="Against the live page" value={p.keptPct != null ? `Keeps ${p.keptPct}% of the live text, adds ${p.addedWords ?? 0} words (${p.renderedChecked ? "as a visitor sees it" : "page source"})` : null} />
        <Field label="Why" value={p.why} />
        {p.decisionNote ? <Field label="Decision note" value={`${previewDecider(p)} · "${p.decisionNote}"`} /> : null}
      </div>
      {p.overlapIds.length > 0 ? <span style={{ fontSize: 12, color: tokens.muted }}>{p.overlapIds.length} other pending preview{p.overlapIds.length === 1 ? "" : "s"} for this page.</span> : null}
      {error ? <Banner tone="bad">{error}</Banner> : null}
      <PreviewActions p={p} {...actions} />
    </Modal>
  );
}

function DeclineModal({ items, onClose, onSubmit, errors }: { items: PreviewItem[]; onClose: () => void; onSubmit: (note: string) => Promise<boolean>; errors: Record<string, string> }) {
  const [note, setNote] = useState("");
  const [sending, setSending] = useState(false);
  const short = note.trim().length < MIN_REASON;
  const firstError = items.map((p) => errors[p.id]).find(Boolean);
  return (
    <Modal
      open
      title={items.length === 1 ? "Decline this preview" : `Decline ${items.length} previews`}
      description="The SEO agent reads your reason, so say what to change."
      onClose={onClose}
      footer={
        <>
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="button" variant="primary" disabled={short || sending} onClick={() => { setSending(true); void onSubmit(note.trim()).finally(() => setSending(false)); }}>Decline</Button>
        </>
      }
    >
      <TextArea value={note} onChange={(e) => setNote(e.target.value)} rows={4} aria-label="Reason for declining" placeholder="Why is this declined? (at least 10 characters)" />
      <span style={{ fontSize: 12, color: tokens.muted }}>{short ? `${MIN_REASON - note.trim().length} more character${MIN_REASON - note.trim().length === 1 ? "" : "s"} needed` : "Ready"}</span>
      {firstError ? <Banner tone="bad">{firstError}</Banner> : null}
    </Modal>
  );
}
