import { useEffect, useState } from "react";
import { Button, Field, Input, Pill, tokens } from "@partnersinbiz/pib-plugin-ui";
import { Banner, Card, fmtDate, ignore, Muted, Row, scopeParams, SmallButton } from "./parts.js";
import type { ApprovalPolicyView, ApprovalStatus, Post, RequestedApproval, RunAction, SignoffState, Snapshot } from "./types.js";

const STAGE_LABEL = { reviewer: "The Reviewer passes it", owner: "A team member approves", client: "The client approves" } as const;
const STATE_TONE: Record<SignoffState, "ok" | "bad" | "warn" | "neutral"> = { approved: "ok", changes: "bad", stale: "warn", none: "neutral" };
const STATE_TEXT: Record<SignoffState, string> = { approved: "done", changes: "asked for changes", stale: "done for an older version", none: "not yet" };

/** Said wherever the client alone approves: the link is the approval, and an agent holds it while it drafts the email. */
export const CLIENT_ONLY_NOTE =
  "Only the client approves here, so their link is the approval. The Social agent makes the link and holds it while it drafts the email. The approval page refuses answers that come from the server itself, which stops a slip but not a determined attempt: tick \"A team member approves\" too if nobody should be able to approve without a person's click.";

const checkStyle = { display: "flex", gap: 8, alignItems: "center", fontSize: 13, cursor: "pointer" } as const;

/** Who approves posts in this scope, and (for a person) a way to change it. An agent can never change it. */
export function ApprovalPolicyCard({ snapshot, run }: { snapshot: Snapshot; run: RunAction }) {
  const policy: ApprovalPolicyView | undefined = snapshot.approvalPolicy;
  const isUser = Boolean(snapshot.viewer.userId);
  const isClient = Boolean(snapshot.scope);
  const [editing, setEditing] = useState(false);
  const [reviewer, setReviewer] = useState(false);
  const [owner, setOwner] = useState(true);
  const [client, setClient] = useState(false);
  const [days, setDays] = useState("14");
  if (!policy) return null;
  const open = () => {
    setReviewer(policy.requireReviewer);
    setOwner(policy.requireOwner);
    setClient(policy.requireClient);
    setDays(String(policy.linkExpiryDays));
    setEditing(true);
  };
  const valid = owner || client;
  const save = () =>
    run("social.set-approval-policy", { ...scopeParams(snapshot), requireReviewer: reviewer, requireOwner: owner, requireClient: client && isClient, linkExpiryDays: Number(days) || 14 }, "Saved")
      .then(() => setEditing(false))
      .catch(ignore);
  return (
    <Card style={{ gap: 8 }}>
      <Row style={{ justifyContent: "space-between" }}>
        <strong style={{ fontSize: 13 }}>Who approves posts{isClient ? ` for ${snapshot.client?.name ?? "this client"}` : " (own work)"}</strong>
        {isUser && !editing ? <SmallButton onClick={open}>Change</SmallButton> : null}
      </Row>
      {!editing ? (
        <Muted>
          {policy.summary.charAt(0).toUpperCase() + policy.summary.slice(1)}.
          {policy.requireClient ? ` The client gets a link that stays open ${policy.linkExpiryDays} days.` : ""}
          {" "}Agents draft and send for review; they never click Approve.
          {policy.requireClient && !policy.requireOwner ? ` ${CLIENT_ONLY_NOTE}` : ""}
        </Muted>
      ) : (
        <div style={{ display: "grid", gap: 8 }}>
          <label style={checkStyle}><input type="checkbox" checked={owner} onChange={(e) => setOwner(e.target.checked)} /> A team member approves (clicks Approve here)</label>
          <label style={{ ...checkStyle, opacity: isClient ? 1 : 0.5 }}>
            <input type="checkbox" checked={client && isClient} disabled={!isClient} onChange={(e) => setClient(e.target.checked)} /> The client approves on a link we email them
          </label>
          <label style={checkStyle}><input type="checkbox" checked={reviewer} onChange={(e) => setReviewer(e.target.checked)} /> The Reviewer passes it first (a check, never an approval)</label>
          {client && isClient ? (
            <Field label="The client's link stays open (days)">
              <Input type="number" min={1} max={60} value={days} onChange={(e) => setDays(e.target.value)} />
            </Field>
          ) : null}
          {!valid ? <Muted style={{ color: tokens.fg }}>Someone has to approve: a team member, the client, or both.</Muted> : null}
          {!owner && client && isClient ? <Muted style={{ color: tokens.fg }}>{CLIENT_ONLY_NOTE}</Muted> : null}
          {!isClient ? <Muted>Own work has no client. Open a client's workspace from the CRM to let them approve their own posts.</Muted> : null}
          <Row>
            <Button type="button" style={{ height: 28, fontSize: 12 }} disabled={!valid} onClick={() => void save()}>Save</Button>
            <SmallButton onClick={() => setEditing(false)}>Cancel</SmallButton>
          </Row>
        </div>
      )}
    </Card>
  );
}

/** One post's sign-offs, the client's links, and the buttons a person has: make the link, record the client's answer. */
export function PostApproval({ post, snapshot, run }: { post: Post; snapshot: Snapshot; run: RunAction }) {
  const [status, setStatus] = useState<ApprovalStatus | null>(null);
  const [link, setLink] = useState<RequestedApproval | null>(null);
  const [recording, setRecording] = useState(false);
  const [note, setNote] = useState("");
  const [by, setBy] = useState("");
  const isUser = Boolean(snapshot.viewer.userId);
  useEffect(() => {
    if (post.status !== "review") return;
    let cancelled = false;
    run("social.approval-status", { postId: post.id })
      .then((res) => {
        if (!cancelled) setStatus(res as ApprovalStatus);
      })
      .catch(ignore);
    return () => {
      cancelled = true;
    };
  }, [post.id, post.updatedAt, post.status, link?.approvalId]);
  if (post.status !== "review" || !status) return null;
  const policy = status.policy;
  const stages = (["reviewer", "owner", "client"] as const).filter((stage) => (stage === "reviewer" ? policy.requireReviewer : stage === "owner" ? policy.requireOwner : policy.requireClient));
  // Nothing beyond the default (a team member approves) needs a card of its own.
  if (!policy.custom && !status.clientLinks.length) return null;
  const tz = snapshot.config.timezone;
  const makeLink = () => run("social.request-client-approval", { postId: post.id }, "Link made").then((res) => setLink(res as RequestedApproval)).catch(ignore);
  const record = () =>
    run("social.record-client-approval", { postId: post.id, note, by: by || undefined }, "Client approval recorded").then(() => {
      setRecording(false);
      setNote("");
    }).catch(ignore);
  return (
    <Card style={{ gap: 8 }}>
      <strong style={{ fontSize: 12 }}>Approval</strong>
      <Muted>{policy.summary.charAt(0).toUpperCase() + policy.summary.slice(1)}. Sign-offs count for this version of the post: editing it starts them again.</Muted>
      {stages.map((stage) => (
        <Row key={stage} style={{ justifyContent: "space-between" }}>
          <span style={{ fontSize: 12 }}>{STAGE_LABEL[stage]}</span>
          <Pill size="sm" variant="outline" tone={STATE_TONE[status.signoffs[stage]]} dot>{STATE_TEXT[status.signoffs[stage]]}</Pill>
        </Row>
      ))}
      {status.clientLinks.slice(0, 3).map((l) => (
        <Muted key={l.approvalId}>
          Client link {l.createdAt ? `made ${fmtDate(l.createdAt, tz)}` : ""}: {l.status.replace("_", " ")}
          {l.status === "pending" && l.expiresAt ? `, open until ${fmtDate(l.expiresAt, tz)}` : ""}
          {l.answeredBy ? ` · ${l.answeredBy}` : ""}
          {l.status !== "superseded" && !l.current && l.status !== "expired" ? " · older version of the post" : ""}
          {l.note ? ` · "${l.note.slice(0, 160)}"` : ""}
        </Muted>
      ))}
      {link ? (
        <Banner tone="info" title="The client's link (shown once)">
          <div style={{ display: "grid", gap: 6 }}>
            <input readOnly value={link.url} onFocus={(e) => e.currentTarget.select()} style={{ width: "100%", fontSize: 12, padding: "6px 8px" }} />
            <Muted>Send it with this email (to {link.recipients.length ? link.recipients.map((r) => `${r.name} <${r.email}>`).join(" or ") : "the client's contact"}). Open until {fmtDate(link.expiresAt, tz)}.</Muted>
            <textarea readOnly value={`${link.email.subject}\n\n${link.email.text}`} onFocus={(e) => e.currentTarget.select()} style={{ width: "100%", minHeight: 150, fontSize: 12, padding: "6px 8px" }} />
          </div>
        </Banner>
      ) : null}
      {isUser && policy.requireClient && post.status === "review" ? (
        recording ? (
          <div style={{ display: "grid", gap: 6 }}>
            <Field label="How did the client approve? (who, when, how: kept as the record)">
              <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Sam at Acme said yes by email on 3 Oct" />
            </Field>
            <Field label="Client's name (optional)">
              <Input value={by} onChange={(e) => setBy(e.target.value)} />
            </Field>
            <Row>
              <Button type="button" style={{ height: 28, fontSize: 12 }} disabled={note.trim().length < 10} onClick={() => void record()}>Record client approval</Button>
              <SmallButton onClick={() => setRecording(false)}>Cancel</SmallButton>
            </Row>
          </div>
        ) : (
          <Row>
            <SmallButton onClick={() => void makeLink()}>Make the client's link</SmallButton>
            <SmallButton onClick={() => setRecording(true)}>Record a client approval…</SmallButton>
          </Row>
        )
      ) : null}
    </Card>
  );
}
