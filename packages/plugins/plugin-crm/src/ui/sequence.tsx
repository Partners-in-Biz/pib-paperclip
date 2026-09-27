/**
 * Sequences: how due steps go out (an issue for a person, or an email from
 * the Mailbox once a person approved it), whether email can go out at all
 * (Gmail connected), and the drawer with the steps and who is enrolled.
 */
import { useEffect, useState } from "react";
import { useHostNavigation, usePluginAction } from "@paperclipai/plugin-sdk/ui";
import {
  Button,
  MailCheck,
  Pill,
  Sheet,
  Workflow,
  errorText,
  formatShortDate,
  tokens,
  tone,
  useIsNarrow,
  usePluginSetupStatus,
} from "@partnersinbiz/pib-plugin-ui";
import { withClientParam } from "@partnersinbiz/pib-plugin-kit/client-ref";
import { delayText, gmailLine, gmailState, type GmailState } from "./crm-view.js";
import { useModuleEnabled } from "./module-switch.js";
import { LineBanner } from "./parts.js";

export const MAILBOX_PLUGIN = "partnersinbiz.mailbox";

export interface SequenceView {
  id: string;
  name: string;
  completionMode: string;
  delivery?: "issue" | "email";
  emailApproved?: boolean;
  approvalIssueId?: string | null;
}

interface SequenceDetail {
  steps: Array<{ position: number; delayMinutes: number; title: string; body: string }>;
  enrolled: Array<{ contactId: string; name: string; status: string; stepPosition: number; nextDueAt: string | null; issueId?: string | null; sending?: boolean }>;
  hidden: number;
}

/** Whether email steps can go out, from the Mailbox's own checklist. Pass null to skip the check. */
export function useGmailState(companyId: string | null | undefined): GmailState | null {
  const status = usePluginSetupStatus(MAILBOX_PLUGIN, companyId ?? null);
  const enabled = useModuleEnabled(companyId ?? null, MAILBOX_PLUGIN);
  if (!companyId) return null;
  return gmailState(status, enabled);
}

/** The one-line banner when email steps cannot go out, with the way to fix it. */
export function GmailBanner({ state, emailSequences }: { state: GmailState | null; emailSequences: number }) {
  const navigation = useHostNavigation();
  const text = gmailLine(state, emailSequences);
  if (!text) return null;
  const off = state === "off";
  return (
    <LineBanner
      text={text}
      tone={emailSequences > 0 ? "warn" : "info"}
      link={{ label: off ? "Turn it on in Setup" : state === "reconnect" ? "Reconnect Gmail" : "Connect Gmail", props: navigation.linkProps(off ? "/setup" : "/mailbox") as unknown as Record<string, unknown> }}
    />
  );
}

/** How due steps go out, and whether email is approved yet. */
export function DeliveryPill({ sequence }: { sequence: SequenceView }) {
  if (sequence.delivery !== "email") return <Pill tone="info" icon={Workflow}>Issue for a person</Pill>;
  return sequence.emailApproved
    ? <Pill tone="ok" icon={MailCheck} dot>Email · approved</Pill>
    : <Pill tone="warn" dot>Email · waiting for approval</Pill>;
}

export function deliveryText(sequence: SequenceView): string {
  if (sequence.delivery !== "email") return "Each step: an issue for a person";
  return sequence.emailApproved ? "Each step: an email (approved)" : "Each step: an email, waiting for approval";
}

const STATUS_WORD: Record<string, string> = { running: "In progress", done: "Finished", stopped: "Stopped" };

export function SequenceSheet({ sequence, gmail, onClose, onChanged }: {
  sequence: SequenceView | null;
  gmail: GmailState | null;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const navigation = useHostNavigation();
  const narrow = useIsNarrow();
  const loadDetail = usePluginAction("crm.sequence-detail");
  const setDelivery = usePluginAction("crm.set-sequence-delivery");
  const [detail, setDetail] = useState<SequenceDetail | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ text: string; bad?: boolean } | null>(null);
  const id = sequence?.id ?? null;

  useEffect(() => {
    setDetail(null);
    setFailed(false);
    setNotice(null);
    if (!id) return;
    let live = true;
    loadDetail({ sequenceId: id })
      .then((result) => {
        if (live) setDetail(result as SequenceDetail);
      })
      .catch(() => {
        if (live) setFailed(true);
      });
    return () => {
      live = false;
    };
  }, [id]);

  if (!sequence) return null;
  const current = sequence;
  const email = current.delivery === "email";
  const gmailBlocked = gmail === "missing" || gmail === "reconnect" || gmail === "off";

  async function switchTo(delivery: "issue" | "email") {
    setBusy(true);
    setNotice(null);
    try {
      await setDelivery({ sequenceId: current.id, delivery });
      await onChanged().catch(() => undefined);
      setNotice({
        text: delivery === "issue"
          ? "Due steps open an issue for a person again."
          : current.emailApproved
            ? "Due steps are emailed from the Mailbox."
            : "Approval asked for. Nothing is emailed until a person approves it.",
      });
    } catch (error) {
      setNotice({ text: errorText(error), bad: true });
    } finally {
      setBusy(false);
    }
  }

  const running = detail?.enrolled.filter((row) => row.status === "running") ?? [];
  const sectionTitle = { fontSize: 12, fontWeight: 600, color: tokens.muted } as const;

  return (
    <Sheet open title={current.name} onClose={onClose}>
      {notice ? (
        <p role="status" style={{ margin: 0, fontSize: 13, padding: "8px 12px", borderRadius: 10, border: `1px solid ${notice.bad ? tone("bad").border : tokens.border}`, background: notice.bad ? tone("bad").soft : tokens.secondary, color: notice.bad ? tone("bad").fg : tokens.fg, overflowWrap: "anywhere" }}>
          {notice.text}
        </p>
      ) : null}

      <div style={{ display: "grid", gap: 8 }}>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <DeliveryPill sequence={current} />
          <span style={{ fontSize: 12.5, color: tokens.muted }}>
            {current.completionMode === "sent" ? "A step counts as done once its message really went out." : "A step counts as done when its issue is marked done."}
          </span>
        </div>
        {email && !current.emailApproved ? (
          <p style={{ margin: 0, fontSize: 12.5, color: tokens.muted, lineHeight: 1.45 }}>
            Nothing is emailed until a person approves it{current.approvalIssueId ? <> in <a {...navigation.linkProps(`/issues/${current.approvalIssueId}`)} style={{ color: tokens.primary, fontWeight: 600 }}>the approval issue</a></> : null}. Until then due steps wait.
          </p>
        ) : null}
        {email ? <GmailBanner state={gmail} emailSequences={1} /> : null}
      </div>

      <div style={{ display: "grid", gap: 8 }}>
        <div style={sectionTitle}>Steps</div>
        {failed ? <p style={{ margin: 0, fontSize: 13, color: tokens.muted }}>The steps could not load.</p> : detail === null ? <p style={{ margin: 0, fontSize: 13, color: tokens.muted }}>Loading…</p> : detail.steps.length === 0 ? (
          <p style={{ margin: 0, fontSize: 13, color: tokens.muted }}>No steps.</p>
        ) : (
          <ol style={{ margin: 0, padding: 0, listStyle: "none", display: "grid", gap: 8 }}>
            {detail.steps.map((step) => (
              <li key={step.position} style={{ display: "grid", gap: 3, padding: "8px 10px", borderRadius: 10, border: `1px solid ${tokens.border}`, minWidth: 0 }}>
                <div style={{ display: "flex", gap: 8, alignItems: "baseline", justifyContent: "space-between", flexWrap: "wrap" }}>
                  <strong style={{ fontSize: 13, minWidth: 0, overflowWrap: "anywhere" }}>{step.position}. {step.title}</strong>
                  <span style={{ fontSize: 12, color: tokens.muted, whiteSpace: "nowrap" }}>{delayText(step.delayMinutes)}</span>
                </div>
                {step.body ? (
                  <p style={{ margin: 0, fontSize: 12.5, color: tokens.muted, lineHeight: 1.45, display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical", overflow: "hidden", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{step.body}</p>
                ) : null}
              </li>
            ))}
          </ol>
        )}
      </div>

      <div style={{ display: "grid", gap: 8 }}>
        <div style={sectionTitle}>Enrolled{detail ? ` · ${running.length} in progress` : ""}</div>
        {detail === null ? null : detail.enrolled.length === 0 ? (
          <p style={{ margin: 0, fontSize: 13, color: tokens.muted }}>Nobody yet. Enroll a contact from their page (Contact tools).</p>
        ) : (
          <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "grid" }}>
            {detail.enrolled.slice(0, 50).map((row, index) => (
              <li key={`${row.contactId}-${index}`} style={{ display: "flex", gap: 8, alignItems: "center", justifyContent: "space-between", padding: "8px 0", borderTop: index === 0 ? "none" : `1px solid ${tokens.border}`, minWidth: 0 }}>
                <a {...navigation.linkProps(withClientParam("/crm", { kind: "contact", id: row.contactId }))} style={{ fontSize: 13, fontWeight: 600, color: tokens.fg, textDecoration: "none", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", lineHeight: narrow ? "40px" : undefined }}>{row.name}</a>
                <span style={{ fontSize: 12, color: tokens.muted, whiteSpace: "nowrap" }}>
                  {row.status !== "running" ? STATUS_WORD[row.status] ?? row.status : (
                    <>
                      Step {row.stepPosition} · {row.issueId
                        ? <a {...navigation.linkProps(`/issues/${row.issueId}`)} style={{ color: tokens.primary, fontWeight: 600, textDecoration: "none", display: "inline-flex", alignItems: "center", minHeight: narrow ? 40 : undefined }}>its issue is open</a>
                        : row.sending ? "sending" : row.nextDueAt ? `due ${formatShortDate(row.nextDueAt)}` : "waiting"}
                    </>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
        {detail && detail.hidden > 0 ? <p style={{ margin: 0, fontSize: 12, color: tokens.muted }}>And {detail.hidden} you cannot see.</p> : null}
      </div>

      <div style={{ display: "grid", gap: 8, paddingTop: 12, borderTop: `1px solid ${tokens.border}` }}>
        <div style={sectionTitle}>How steps go out</div>
        {email ? (
          <>
            <p style={{ margin: 0, fontSize: 12.5, color: tokens.muted, lineHeight: 1.45 }}>Each due step is emailed to the contact from the Mailbox. Switching back makes each due step an issue for a person again; nothing more is emailed.</p>
            <div><Button type="button" variant="secondary" disabled={busy} onClick={() => void switchTo("issue")}>Switch back to issues</Button></div>
          </>
        ) : (
          <>
            <p style={{ margin: 0, fontSize: 12.5, color: tokens.muted, lineHeight: 1.45 }}>
              Now each due step opens an issue for a person. Switch to email delivery to have the Mailbox email each step to the contact instead. This sends nothing now: a person approves the switch once, before the first email goes out.
            </p>
            <div><Button type="button" variant="secondary" disabled={busy || gmailBlocked} onClick={() => void switchTo("email")}>Switch to email delivery</Button></div>
            {gmailBlocked ? <GmailBanner state={gmail} emailSequences={0} /> : null}
          </>
        )}
      </div>
    </Sheet>
  );
}
