/**
 * The client care card on a client's page: health score, support cases, what we
 * have asked the client to do, monthly reports, website monitoring and how
 * sensitive the client's data is. Everything shown is read by the worker
 * (`care` in the client workspace); every button runs a page action `crm.<tool>`.
 * Anything that goes out to the client still waits for a person's approval.
 */
import { useState, type FormEvent } from "react";
import { Button, EmptyState, Field, Form, HeartPulse, Input, Modal, Pill, SectionCard, Select, TextArea, tokens } from "@partnersinbiz/pib-plugin-ui";
import {
  ACTION_KIND_LABEL,
  ACTION_STATUS_LABEL,
  actionLine,
  actionTone,
  BAND_LABEL,
  bandTone,
  canSendReport,
  CASE_STATUS_LABEL,
  consentLine,
  caseOpen,
  lastMonth,
  reportLine,
  reportTone,
  severityTone,
  SEVERITY_LABEL,
  siteLine,
  slaLine,
  type CareView,
} from "./care-view.js";

const muted = { margin: 0, fontSize: 12.5, color: tokens.muted, lineHeight: 1.45 } as const;
const smallButton = { height: 28, fontSize: 12 } as const;
const rowStyle = { display: "grid", gap: 6, padding: 10, borderRadius: 10, border: `1px solid ${tokens.border}`, minWidth: 0 } as const;

type Run = (action: string, params: Record<string, unknown>, success: string) => Promise<boolean>;

function Heading({ children, action }: { children: string; action?: React.ReactNode }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, marginTop: 14 }}>
      <strong style={{ fontSize: 13 }}>{children}</strong>
      {action}
    </div>
  );
}

export function ClientCareCard({ care, clientRef, onRun }: { care: CareView; clientRef: string; onRun: Run }) {
  const now = Date.now();
  const [busy, setBusy] = useState<string | null>(null);
  const [caseForm, setCaseForm] = useState(false);
  const [requestForm, setRequestForm] = useState(false);
  const [resolving, setResolving] = useState<string | null>(null);
  const [caseTitle, setCaseTitle] = useState("");
  const [caseSummary, setCaseSummary] = useState("");
  const [caseSeverity, setCaseSeverity] = useState("normal");
  const [resolution, setResolution] = useState("");
  const [kind, setKind] = useState("sign_off");
  const [requestTitle, setRequestTitle] = useState("");
  const [link, setLink] = useState("");
  const [instructions, setInstructions] = useState("");
  const [dueInDays, setDueInDays] = useState("");
  const [level, setLevel] = useState(care.sensitivity.level);
  const [reason, setReason] = useState(care.sensitivity.reason ?? "");

  async function run(key: string, action: string, params: Record<string, unknown>, success: string): Promise<boolean> {
    setBusy(key);
    const ok = await onRun(action, params, success);
    setBusy(null);
    return ok;
  }

  async function openCase(event: FormEvent) {
    event.preventDefault();
    const ok = await run("case", "open-support-case", { client: clientRef, title: caseTitle, summary: caseSummary || undefined, severity: caseSeverity }, "Case opened");
    if (ok) {
      setCaseForm(false);
      setCaseTitle("");
      setCaseSummary("");
      setCaseSeverity("normal");
    }
  }

  async function ask(event: FormEvent) {
    event.preventDefault();
    const ok = await run("request", "create-client-action", { client: clientRef, kind, title: requestTitle, link: link || undefined, instructions: instructions || undefined, dueInDays: dueInDays ? Number(dueInDays) : undefined }, "Drafted. A person approves the email before it is sent: look for it under Needs you.");
    if (ok) {
      setRequestForm(false);
      setRequestTitle("");
      setLink("");
      setInstructions("");
      setDueInDays("");
    }
  }

  async function resolve(event: FormEvent) {
    event.preventDefault();
    if (!resolving) return;
    const ok = await run(resolving, "update-support-case", { caseId: resolving, status: "resolved", resolution }, "Case resolved");
    if (ok) {
      setResolving(null);
      setResolution("");
    }
  }

  const health = care.health;
  const openCases = care.cases.filter(caseOpen);
  const closedCases = care.cases.filter((c) => !caseOpen(c)).slice(0, 3);
  const month = lastMonth(new Date());
  const lastReport = care.reports.find((r) => r.period === month);

  return (
    <SectionCard title="Client care" icon={HeartPulse} subtitle="Health, support, what we are waiting on the client for, monthly reports and website monitoring. Anything sent to the client waits for a person's approval.">
      {health ? (
        <div style={{ display: "grid", gap: 6 }}>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <strong style={{ fontSize: 22 }}>{health.score}</strong>
            <Pill size="sm" tone={bandTone(health.band)} dot>{BAND_LABEL[health.band]}</Pill>
            <span style={muted}>health score of 100{health.previousScore !== null ? `, was ${health.previousScore}` : ""}</span>
          </div>
          <ul style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 2, fontSize: 12.5, color: tokens.muted }}>
            {health.parts.map((part) => <li key={part.part}><strong style={{ color: tokens.fg }}>{part.part}</strong> {part.score}: {part.why}</li>)}
          </ul>
          {health.notMeasured.length ? <p style={muted}>Not measured yet: {health.notMeasured.join(", ")}.</p> : null}
        </div>
      ) : null}

      <Heading action={<Button type="button" variant="secondary" style={smallButton} onClick={() => setCaseForm(true)}>+ Open a case</Button>}>Support cases</Heading>
      {openCases.length === 0 && closedCases.length === 0 ? <p style={muted}>No support cases.</p> : null}
      <ul style={{ margin: "6px 0 0", padding: 0, listStyle: "none", display: "grid", gap: 8 }}>
        {[...openCases, ...closedCases].map((c) => {
          const sla = slaLine(c, now);
          return (
            <li key={c.caseId} style={rowStyle}>
              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <strong style={{ fontSize: 13, overflowWrap: "anywhere" }}>{c.title}</strong>
                <Pill size="sm" tone={severityTone(c.severity)}>{SEVERITY_LABEL[c.severity]}</Pill>
                <Pill size="sm" tone="neutral">{CASE_STATUS_LABEL[c.status]}</Pill>
              </div>
              <p style={{ ...muted, color: sla.tone === "bad" ? tokens.tones.bad.fg : sla.tone === "warn" ? tokens.tones.warn.fg : tokens.muted }}>{sla.text}</p>
              {caseOpen(c) ? (
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  {!c.firstResponseAt ? <Button type="button" variant="secondary" style={smallButton} disabled={busy === c.caseId} onClick={() => void run(c.caseId, "update-support-case", { caseId: c.caseId, firstResponse: true }, "First response recorded")}>I answered them</Button> : null}
                  {c.status !== "waiting_client" ? <Button type="button" variant="secondary" style={smallButton} disabled={busy === c.caseId} onClick={() => void run(c.caseId, "update-support-case", { caseId: c.caseId, status: "waiting_client" }, "Waiting on the client: the clock is paused")}>Waiting on the client</Button> : <Button type="button" variant="secondary" style={smallButton} disabled={busy === c.caseId} onClick={() => void run(c.caseId, "update-support-case", { caseId: c.caseId, status: "open" }, "Case is open again")}>They answered</Button>}
                  <Button type="button" variant="secondary" style={smallButton} onClick={() => setResolving(c.caseId)}>Resolve</Button>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>

      <Heading action={<Button type="button" variant="secondary" style={smallButton} onClick={() => setRequestForm(true)}>+ Ask the client</Button>}>Asked of the client</Heading>
      {care.actions.length === 0 ? <p style={muted}>Nothing asked of this client. A sign-off, a grant or some information goes here, with the exact link.</p> : null}
      <ul style={{ margin: "6px 0 0", padding: 0, listStyle: "none", display: "grid", gap: 8 }}>
        {care.actions.slice(0, 8).map((a) => (
          <li key={a.actionId} style={rowStyle}>
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <strong style={{ fontSize: 13, overflowWrap: "anywhere" }}>{a.title}</strong>
              <Pill size="sm" tone="neutral">{ACTION_KIND_LABEL[a.kind]}</Pill>
              <Pill size="sm" tone={actionTone(a)} dot>{ACTION_STATUS_LABEL[a.status]}</Pill>
            </div>
            <p style={muted}>{actionLine(a, now)}</p>
            {a.link ? <a href={a.link} target="_blank" rel="noreferrer" style={{ color: tokens.primary, fontSize: 12.5, overflowWrap: "anywhere" }}>{a.link.replace(/^https?:\/\//, "")} ↗</a> : null}
            {a.status === "waiting" || a.status === "replied" || a.status === "draft" ? (
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {a.status !== "draft" ? <Button type="button" variant="secondary" style={smallButton} disabled={busy === a.actionId} onClick={() => void run(a.actionId, "update-client-action", { actionId: a.actionId, status: "done" }, "Marked done")}>They did it</Button> : null}
                <Button type="button" variant="secondary" style={smallButton} disabled={busy === a.actionId} onClick={() => void run(a.actionId, "update-client-action", { actionId: a.actionId, status: "cancelled" }, "Request cancelled")}>Cancel</Button>
              </div>
            ) : null}
          </li>
        ))}
      </ul>

      <Heading action={!lastReport ? <Button type="button" variant="secondary" style={smallButton} disabled={busy === "build"} onClick={() => void run("build", "build-client-report", { client: clientRef, period: month }, "Report built")}>{busy === "build" ? "Building…" : "Build last month's report"}</Button> : undefined}>Monthly reports</Heading>
      {care.reports.length === 0 ? <p style={muted}>No report yet. The CRM opens one for the Account Manager on the 1st of each month.</p> : null}
      <ul style={{ margin: "6px 0 0", padding: 0, listStyle: "none", display: "grid", gap: 6 }}>
        {care.reports.slice(0, 6).map((r) => (
          <li key={r.reportId} style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", justifyContent: "space-between" }}>
            <span style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <span style={{ fontSize: 13 }}>{reportLine(r)}</span>
              <Pill size="sm" tone={reportTone(r.status)} dot>{r.status === "sent" || r.status === "dry_run" ? "Done" : r.status === "awaiting_approval" ? "With a person" : r.status === "skipped" ? "Skipped" : "In progress"}</Pill>
            </span>
            {canSendReport(r) ? <Button type="button" variant="secondary" style={smallButton} disabled={busy === r.reportId} onClick={() => void run(r.reportId, "send-client-report", { client: clientRef, period: r.period }, "Drafted for approval: a person approves the email before it is sent")}>Send for approval</Button> : null}
          </li>
        ))}
      </ul>

      {care.sites.length ? (
        <>
          <Heading>Websites</Heading>
          <ul style={{ margin: "6px 0 0", padding: 0, listStyle: "none", display: "grid", gap: 6 }}>
            {care.sites.map((s) => {
              const line = siteLine(s, now);
              return (
                <li key={s.siteId} style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", justifyContent: "space-between" }}>
                  <span style={{ display: "grid", gap: 2, minWidth: 0 }}>
                    <span style={{ fontSize: 13, overflowWrap: "anywhere" }}>{s.url.replace(/^https?:\/\//, "")}</span>
                    <span style={{ ...muted, color: line.tone === "bad" ? tokens.tones.bad.fg : line.tone === "warn" ? tokens.tones.warn.fg : tokens.muted }}>{line.text}</span>
                  </span>
                  <Button type="button" variant="secondary" style={smallButton} disabled={busy === s.siteId} onClick={() => void run(s.siteId, "set-site-monitoring", { siteId: s.siteId, enabled: !s.monitored }, s.monitored ? "Monitoring paused" : "Monitoring resumed")}>{s.monitored ? "Pause" : "Resume"}</Button>
                </li>
              );
            })}
          </ul>
        </>
      ) : null}

      <Heading>Consent on file</Heading>
      {care.consent.length === 0 ? <p style={muted}>No consent or lawful basis is recorded for this client's people. Marketing email needs one (a tick on a form records its own).</p> : (
        <ul style={{ margin: "6px 0 0", paddingLeft: 18, display: "grid", gap: 2, fontSize: 12.5, color: tokens.muted }}>
          {care.consent.slice(0, 6).map((c, index) => <li key={`${c.person}:${c.purpose}:${index}`}>{consentLine(c)}</li>)}
        </ul>
      )}

      <Heading>Sensitive data</Heading>
      <p style={muted}>A sensitive client's data stays off every system the data-processing register does not clear (outside AI models, TypeSafe, Resend).{care.sensitivity.level === "sensitive" ? ` Flagged sensitive: ${care.sensitivity.reason ?? ""}` : ""}</p>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <Select value={level} onChange={(event) => setLevel(event.target.value as "standard" | "sensitive")} aria-label="How sensitive is this client's data" style={{ maxWidth: 180 }}>
          <option value="standard">Standard</option>
          <option value="sensitive">Sensitive</option>
        </Select>
        {level === "sensitive" ? <Input value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Why (health, legal, children, a contract...)" aria-label="Why the data is sensitive" style={{ minWidth: 220, flex: 1 }} /> : null}
        <Button type="button" variant="secondary" style={smallButton} disabled={busy === "sensitivity" || (level === care.sensitivity.level && (level === "standard" || reason === (care.sensitivity.reason ?? "")))} onClick={() => void run("sensitivity", "set-client-sensitivity", { client: clientRef, level, reason: reason || undefined }, level === "sensitive" ? "Flagged sensitive" : "Back to standard")}>Save</Button>
      </div>

      <Modal open={caseForm} title="Open a support case" description="What the client needs. The targets start now." onClose={() => { if (busy !== "case") setCaseForm(false); }}>
        <Form onSubmit={(event) => void openCase(event)}>
          <Field label="What do they need?"><Input value={caseTitle} onChange={(event) => setCaseTitle(event.target.value)} required placeholder="The contact form emails go to spam" /></Field>
          <Field label="Severity">
            <Select value={caseSeverity} onChange={(event) => setCaseSeverity(event.target.value)}>
              <option value="low">Low: a question or a small request</option>
              <option value="normal">Normal</option>
              <option value="high">High: a key part is broken</option>
              <option value="urgent">Urgent: they cannot work, or money is at risk</option>
            </Select>
          </Field>
          <Field label="Details"><TextArea value={caseSummary} onChange={(event) => setCaseSummary(event.target.value)} rows={3} /></Field>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <Button type="button" variant="secondary" onClick={() => setCaseForm(false)} disabled={busy === "case"}>Cancel</Button>
            <Button type="submit" disabled={busy === "case" || !caseTitle.trim()}>{busy === "case" ? "Opening…" : "Open the case"}</Button>
          </div>
        </Form>
      </Modal>

      <Modal open={requestForm} title="Ask the client to do something" description="The email is drafted for a person to approve. Nothing is sent until they do." onClose={() => { if (busy !== "request") setRequestForm(false); }}>
        <Form onSubmit={(event) => void ask(event)}>
          <Field label="What kind?">
            <Select value={kind} onChange={(event) => setKind(event.target.value)}>
              <option value="sign_off">Sign off a preview or a deliverable</option>
              <option value="grant">Give us access or a login</option>
              <option value="approval">Approve a decision</option>
              <option value="info">Send us something we need</option>
            </Select>
          </Field>
          <Field label="What must they do?"><Input value={requestTitle} onChange={(event) => setRequestTitle(event.target.value)} required placeholder="Approve the new homepage" /></Field>
          <Field label="The exact link they open (https)"><Input value={link} onChange={(event) => setLink(event.target.value)} placeholder="https://preview.partnersinbiz.online/p/…" /></Field>
          <Field label="What to click and expect"><TextArea value={instructions} onChange={(event) => setInstructions(event.target.value)} rows={3} /></Field>
          <Field label="Ask for it within (days, optional)"><Input value={dueInDays} onChange={(event) => setDueInDays(event.target.value.replace(/\D/g, ""))} inputMode="numeric" /></Field>
          <p style={muted}>It goes to the client's first person with an email address. A reminder is drafted after 3 days, and after two the Account Manager reaches them another way.</p>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <Button type="button" variant="secondary" onClick={() => setRequestForm(false)} disabled={busy === "request"}>Cancel</Button>
            <Button type="submit" disabled={busy === "request" || !requestTitle.trim()}>{busy === "request" ? "Drafting…" : "Draft the email"}</Button>
          </div>
        </Form>
      </Modal>

      <Modal open={resolving !== null} title="Resolve this case" description="Say what resolved it, in a sentence." onClose={() => setResolving(null)}>
        <Form onSubmit={(event) => void resolve(event)}>
          <Field label="What resolved it?"><TextArea value={resolution} onChange={(event) => setResolution(event.target.value)} rows={3} required /></Field>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <Button type="button" variant="secondary" onClick={() => setResolving(null)}>Cancel</Button>
            <Button type="submit" disabled={resolution.trim().length < 10 || busy === resolving}>Resolve</Button>
          </div>
        </Form>
      </Modal>
      {care.cases.length === 0 && care.actions.length === 0 && care.reports.length === 0 && !health && care.sites.length === 0 ? (
        <EmptyState compact title="Nothing yet" description="Cases, requests and reports for this client appear here." />
      ) : null}
    </SectionCard>
  );
}
