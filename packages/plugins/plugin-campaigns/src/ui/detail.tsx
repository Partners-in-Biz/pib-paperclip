/**
 * The campaign detail view (in a side sheet): exactly what goes out, to whom
 * and when, so a person can check a campaign before approving it. No host
 * hooks; the page passes the data, the actions and `linkFor`.
 */
import type { ReactNode } from "react";
import { Button, CircleAlert, Clock, Mail, Pill, Send, Users, formatDate, formatShortDate, tokens, tone, type ToneInput } from "@partnersinbiz/pib-plugin-ui";
import { approvalState, bodyPreview, DELIVERY_DETAIL, deliveryLabel, orderedSteps, type NextSend } from "../detail.js";
import { StatusPill } from "./overview.js";

export interface DetailStep { position: number; delayDays: number; subject: string; body: string; htmlBody?: string | null; variant?: "a" | "b" }

export interface CampaignDetailData {
  campaign: {
    id: string;
    name: string;
    description: string;
    status: string;
    delivery?: "issue" | "email";
    audienceTags: string[];
    audienceMode?: "tags" | "client_contacts" | "client_contact";
    client?: { kind: "company" | "contact"; id: string; name: string | null } | null;
    startAt?: string | null;
    launchedAt?: string | null;
    launchError?: string | null;
    approvalIssueId: string | null;
    approvalStatus: string | null;
    winnerVariant?: "a" | "b" | null;
    steps: DetailStep[];
    stats: { enrolled: number; running: number; done: number };
  };
  approval: { issueId: string; identifier: string | null; status: string; withPerson: boolean; withAgent: boolean } | null;
  audience: { matching: number; willGet: number; leftOut: number; sample: string[] } | null;
  enrolled: {
    total: number;
    running: number;
    done: number;
    stopped: number;
    sample: Array<{ name: string | null; status: string; stepPosition: number; nextDueAt: string | null; waiting: boolean }>;
  };
  next: NextSend;
}

export interface DetailActions {
  busy: boolean;
  onRequestApproval: () => void;
  onLaunch: () => void;
  onAddStep: () => void;
  onPause: () => void;
  onResume: () => void;
  onEnrollNew: () => void;
  onComplete: () => void;
  onAb: () => void;
}

const APPROVAL_TONE: Record<string, ToneInput> = { "not-requested": "neutral", waiting: "warn", approved: "ok", "could-not-launch": "bad", launched: "ok", none: "neutral" };

/** "All contacts", "Contacts tagged vip, hot", "Contacts at Northwind", "Northwind only". */
export function audienceText(campaign: Pick<CampaignDetailData["campaign"], "audienceMode" | "audienceTags" | "client">): string {
  const tags = campaign.audienceTags.join(", ");
  const client = campaign.client?.name ?? null;
  if (campaign.audienceMode === "client_contacts") return tags ? `Contacts at ${client ?? "the client"} tagged ${tags}` : `Contacts at ${client ?? "the client"}`;
  if (campaign.audienceMode === "client_contact") return `${client ?? "The client contact"} only`;
  return tags ? `Contacts tagged ${tags}` : "All contacts";
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Numbers of the steps by position (1, 2, 3… even when positions skip). */
function stepNumbers(steps: DetailStep[]): Map<number, number> {
  return new Map(orderedSteps(steps).map((step) => [step.position, step.number]));
}

function nextSendText(data: CampaignDetailData, numbers: Map<number, number>, now = new Date()): string {
  const { campaign, next } = data;
  if (campaign.status === "completed") return "Completed. Nothing more goes out.";
  if (campaign.status === "paused") return "Paused. Nothing goes out until it is resumed.";
  if (campaign.status === "draft") {
    const start = campaign.startAt && Date.parse(campaign.startAt) > now.getTime() ? `on ${formatDate(campaign.startAt)}` : "as soon as it is approved";
    return `Step 1 goes out ${start}.`;
  }
  const parts: string[] = [];
  if (next.waitingOnAgent) parts.push(`${plural(next.waitingOnAgent, "email")} waiting for the agent to send`);
  if (next.sending) parts.push(`${plural(next.sending, "email")} sending now`);
  if (next.at && next.stepPosition != null) {
    const step = numbers.get(next.stepPosition) ?? next.stepPosition;
    const due = Date.parse(next.at) <= now.getTime() + 5 * 60_000 ? "within minutes" : `on ${formatShortDate(next.at, now)}`;
    parts.push(`step ${step} to ${plural(next.contacts, "contact")} ${due}`);
  }
  if (parts.length === 0) return campaign.stats.running ? "Nothing is due yet." : "Nothing left to send: everyone finished or stopped.";
  const text = parts.join("; ");
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
}

function enrolledLine(row: CampaignDetailData["enrolled"]["sample"][number], numbers: Map<number, number>): string {
  const step = numbers.get(row.stepPosition) ?? row.stepPosition;
  if (row.status === "done") return "finished";
  if (row.status === "stopped") return "stopped";
  if (row.waiting) return `step ${step}, waiting for the agent`;
  if (row.nextDueAt && Date.parse(row.nextDueAt) > Date.now() + 5 * 60_000) return `step ${step} on ${formatShortDate(row.nextDueAt)}`;
  return `step ${step}, due now`;
}

export function CampaignDetail({ data, actions, linkFor, now = new Date() }: {
  data: CampaignDetailData;
  actions: DetailActions;
  linkFor: (href: string) => Record<string, unknown>;
  now?: Date;
}) {
  const { campaign, approval, audience, enrolled } = data;
  const state = approvalState(campaign);
  const steps = orderedSteps(campaign.steps);
  const numbers = stepNumbers(campaign.steps);
  const hasB = campaign.steps.some((step) => step.variant === "b");
  const usesTokens = campaign.steps.some((step) => /\{\{[^}]+\}\}/.test(`${step.subject} ${step.body}`));
  const issueLink = approval ? linkFor(`/issues/${approval.identifier ?? approval.issueId}`) : null;
  const issueName = approval?.identifier ?? "the approval task";
  const small = { height: 32, fontSize: 12.5 };

  // One main action for the campaign's state; the rest are secondary.
  let main: ReactNode = null;
  const secondary: ReactNode[] = [];
  if (campaign.status === "draft") {
    if (steps.length === 0) main = <Button type="button" onClick={actions.onAddStep}>Add the first email</Button>;
    else if (state.key === "not-requested") {
      main = <Button type="button" disabled={actions.busy} onClick={actions.onRequestApproval}>Request approval</Button>;
      secondary.push(<Button key="step" type="button" variant="secondary" style={small} onClick={actions.onAddStep}>Add step</Button>);
    } else if (state.key === "approved") main = <Button type="button" disabled={actions.busy} onClick={actions.onLaunch}>Launch now</Button>;
    else secondary.push(<Button key="step" type="button" variant="secondary" style={small} title="Adding a step cancels the approval request; ask again after." onClick={actions.onAddStep}>Add step</Button>);
  } else if (campaign.status === "paused") {
    main = <Button type="button" disabled={actions.busy} onClick={actions.onResume}>Resume</Button>;
    secondary.push(<Button key="enroll" type="button" variant="secondary" style={small} disabled={actions.busy} title="Enroll audience contacts who are not in it yet, then run" onClick={actions.onEnrollNew}>Enroll new contacts</Button>);
    secondary.push(<Button key="complete" type="button" variant="secondary" style={small} disabled={actions.busy} onClick={actions.onComplete}>Complete</Button>);
  } else if (campaign.status === "active" || campaign.status === "scheduled") {
    secondary.push(<Button key="pause" type="button" variant="secondary" style={small} disabled={actions.busy} onClick={actions.onPause}>Pause</Button>);
    if (campaign.status === "active") secondary.push(<Button key="complete" type="button" variant="secondary" style={small} disabled={actions.busy} onClick={actions.onComplete}>Complete</Button>);
  }
  if (hasB && (campaign.status === "active" || campaign.status === "paused")) {
    secondary.push(<Button key="ab" type="button" variant="secondary" style={small} onClick={actions.onAb}>{campaign.winnerVariant ? `A/B: ${campaign.winnerVariant.toUpperCase()} won` : "A/B results"}</Button>);
  }

  return (
    <div style={{ display: "grid", gap: 18, minWidth: 0 }}>
      <div style={{ display: "grid", gap: 10, minWidth: 0 }}>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
          <StatusPill status={campaign.status} />
          <Pill tone={APPROVAL_TONE[state.key] ?? "neutral"} dot>{state.label}</Pill>
        </div>
        {campaign.description ? <p style={{ margin: 0, fontSize: 13, color: tokens.muted, lineHeight: 1.5, overflowWrap: "anywhere" }}>{campaign.description}</p> : null}
        {state.key === "waiting" ? (
          <Callout tone="warn">
            A person approves it on {issueLink ? <a {...issueLink} style={{ color: "inherit", fontWeight: 600 }}>{issueName}</a> : issueName}. It then launches by itself. Check the emails below first.
          </Callout>
        ) : null}
        {state.key === "could-not-launch" ? (
          <Callout tone="bad">
            It was approved but could not launch: {campaign.launchError}. Fix that, then approve again on {issueLink ? <a {...issueLink} style={{ color: "inherit", fontWeight: 600 }}>{issueName}</a> : issueName}.
          </Callout>
        ) : null}
        {main || secondary.length ? (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            {main}
            {secondary}
          </div>
        ) : null}
      </div>

      <dl style={{ margin: 0, display: "grid", gridTemplateColumns: "minmax(86px, auto) minmax(0, 1fr)", gap: "10px 14px", fontSize: 13, lineHeight: 1.45 }}>
        <Fact term="Delivery">
          <strong style={{ fontWeight: 600 }}>{deliveryLabel(campaign.delivery)}</strong>
          <span style={{ display: "block", color: tokens.muted, fontSize: 12.5 }}>{DELIVERY_DETAIL[campaign.delivery === "email" ? "email" : "issue"]}</span>
        </Fact>
        <Fact term="Audience">
          {audienceText(campaign)}
          {audience ? <span style={{ color: tokens.muted }}> · {plural(audience.matching, "contact")} match now</span> : null}
        </Fact>
        <Fact term="Next send">{nextSendText(data, numbers, now)}</Fact>
        {approval ? (
          <Fact term="Approval">
            {issueLink ? <a {...issueLink} style={{ color: tokens.primary, fontWeight: 600 }}>{issueName}</a> : issueName}
            <span style={{ color: tokens.muted }}> · {approval.status === "done" ? `approved${campaign.launchedAt ? `, launched ${formatDate(campaign.launchedAt)}` : ""}` : approval.status === "cancelled" ? "cancelled" : approval.withAgent ? "with the Reviewer first" : "waiting for a person"}</span>
          </Fact>
        ) : null}
      </dl>

      <Section icon={Users} title={campaign.status === "draft" ? "Who gets it" : "Who is enrolled"}>
        {campaign.status === "draft" ? (
          audience ? (
            <>
              <p style={{ margin: 0, fontSize: 13 }}>
                <strong>{plural(audience.willGet, "contact")}</strong> will get it
                {audience.leftOut ? <span style={{ color: tokens.muted }}> · {audience.leftOut} left out (unsubscribed or bounced)</span> : null}
              </p>
              {audience.sample.length ? <Names names={audience.sample} total={audience.willGet} /> : <Muted>Nobody matches this audience yet.</Muted>}
            </>
          ) : <Muted>The audience could not be read just now.</Muted>
        ) : (
          <>
            <p style={{ margin: 0, fontSize: 13 }}>
              <strong>{enrolled.total}</strong> enrolled
              <span style={{ color: tokens.muted }}> · {enrolled.running} in progress, {enrolled.done} finished, {enrolled.stopped} stopped</span>
            </p>
            {enrolled.sample.length ? (
              <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "grid", gap: 4, fontSize: 13 }}>
                {enrolled.sample.map((row, index) => (
                  <li key={index} style={{ display: "flex", gap: 8, justifyContent: "space-between", flexWrap: "wrap", minWidth: 0 }}>
                    <span style={{ fontWeight: 550, overflowWrap: "anywhere" }}>{row.name ?? "A contact no longer in the CRM"}</span>
                    <span style={{ color: tokens.muted }}>{enrolledLine(row, numbers)}</span>
                  </li>
                ))}
                {enrolled.total > enrolled.sample.length ? <li style={{ color: tokens.muted }}>And {enrolled.total - enrolled.sample.length} more.</li> : null}
              </ul>
            ) : <Muted>Nobody is enrolled.</Muted>}
            {campaign.status === "paused" && audience && audience.willGet > enrolled.total ? (
              <Muted>{plural(audience.willGet - enrolled.total, "more contact")} match the audience now. Enroll new contacts adds them.</Muted>
            ) : null}
          </>
        )}
      </Section>

      <Section icon={Mail} title={`Emails, in order (${steps.length})`}>
        {steps.length === 0 ? <Muted>No emails yet. Add the first one; a campaign needs at least one before approval.</Muted> : (
          <ol style={{ margin: 0, padding: 0, listStyle: "none", display: "grid", gap: 10 }}>
            {steps.map((step) => (
              <li key={step.position} style={{ display: "grid", gap: 8, padding: 12, borderRadius: 10, border: `1px solid ${tokens.border}`, background: tokens.bg, minWidth: 0 }}>
                <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                  <span aria-hidden="true" style={{ width: 22, height: 22, borderRadius: 999, display: "inline-grid", placeItems: "center", fontSize: 12, fontWeight: 700, background: tokens.secondary, color: tokens.secondaryFg, flexShrink: 0 }}>{step.number}</span>
                  <strong style={{ fontSize: 13 }}>Step {step.number}</strong>
                  <span style={{ fontSize: 12.5, color: tokens.muted, display: "inline-flex", gap: 4, alignItems: "center" }}><Clock size={12} aria-hidden="true" />{step.timing}</span>
                </div>
                <Email label={step.b ? "Version A" : null} subject={step.a.subject} body={step.a.body} html={Boolean(step.a.htmlBody)} />
                {step.b ? <Email label="Version B (A/B test)" subject={step.b.subject} body={step.b.body} html={Boolean(step.b.htmlBody)} /> : null}
              </li>
            ))}
          </ol>
        )}
        {usesTokens ? <Muted>{"Words in double braces, like {{first_name}}, are filled in for each contact."}</Muted> : null}
      </Section>
    </div>
  );
}

function Email({ label, subject, body, html }: { label: string | null; subject: string; body: string; html: boolean }) {
  const preview = bodyPreview(body);
  return (
    <div style={{ display: "grid", gap: 4, minWidth: 0 }}>
      {label ? <span style={{ fontSize: 11.5, fontWeight: 650, letterSpacing: "0.04em", textTransform: "uppercase", color: tokens.muted }}>{label}</span> : null}
      <span style={{ fontSize: 13.5, fontWeight: 600, overflowWrap: "anywhere" }}>{subject || "(no subject)"}</span>
      {preview.text ? (
        preview.cut ? (
          <details>
            <summary style={{ cursor: "pointer", listStyle: "none", fontSize: 13, color: tokens.muted, whiteSpace: "pre-wrap", overflowWrap: "anywhere", lineHeight: 1.5 }}>
              {preview.text} <span style={{ color: tokens.primary, fontWeight: 600 }}>Show all</span>
            </summary>
            <p style={{ margin: "6px 0 0", fontSize: 13, whiteSpace: "pre-wrap", overflowWrap: "anywhere", lineHeight: 1.5 }}>{body}</p>
          </details>
        ) : <p style={{ margin: 0, fontSize: 13, color: tokens.muted, whiteSpace: "pre-wrap", overflowWrap: "anywhere", lineHeight: 1.5 }}>{preview.text}</p>
      ) : <span style={{ fontSize: 13, color: tone("warn").fg }}>No text yet.</span>}
      {html ? <span style={{ fontSize: 12, color: tokens.muted, display: "inline-flex", gap: 4, alignItems: "center" }}><Send size={12} aria-hidden="true" /> Sent as a designed (HTML) email; the text above is the plain version.</span> : null}
    </div>
  );
}

function Names({ names, total }: { names: string[]; total: number }) {
  return (
    <p style={{ margin: 0, fontSize: 13, color: tokens.muted, lineHeight: 1.5, overflowWrap: "anywhere" }}>
      {names.join(", ")}{total > names.length ? `, and ${total - names.length} more` : ""}.
    </p>
  );
}

function Fact({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div style={{ display: "contents" }}>
      <dt style={{ color: tokens.muted }}>{term}</dt>
      <dd style={{ margin: 0, minWidth: 0, overflowWrap: "anywhere" }}>{children}</dd>
    </div>
  );
}

function Section({ icon: Icon, title, children }: { icon: typeof Users; title: string; children: ReactNode }) {
  return (
    <section style={{ display: "grid", gap: 8, minWidth: 0 }}>
      <h3 style={{ margin: 0, fontSize: 12, fontWeight: 650, letterSpacing: "0.06em", textTransform: "uppercase", color: tokens.muted, display: "flex", gap: 6, alignItems: "center" }}>
        <Icon size={13} aria-hidden="true" /> {title}
      </h3>
      {children}
    </section>
  );
}

function Callout({ tone: t, children }: { tone: "warn" | "bad"; children: ReactNode }) {
  const colors = tone(t);
  return (
    <p role="status" style={{ margin: 0, display: "flex", gap: 8, alignItems: "flex-start", fontSize: 13, lineHeight: 1.45, padding: "9px 12px", borderRadius: 10, border: `1px solid ${colors.border}`, background: colors.soft, color: tokens.fg, overflowWrap: "anywhere" }}>
      <CircleAlert size={15} aria-hidden="true" style={{ color: colors.solid, flexShrink: 0, marginTop: 2 }} />
      <span>{children}</span>
    </p>
  );
}

function Muted({ children }: { children: ReactNode }) {
  return <p style={{ margin: 0, fontSize: 12.5, color: tokens.muted, lineHeight: 1.45 }}>{children}</p>;
}
