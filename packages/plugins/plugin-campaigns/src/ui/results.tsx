/**
 * The Results tab of a campaign: what happened to the emails, in total and
 * per step, with version A against B where a step has both. It says plainly
 * what is and is not measured. No host hooks.
 */
import { useEffect, useRef, useState } from "react";
import { Button, Field, Input, KpiCard, Pill, fluidColumns, formatDate, tokens } from "@partnersinbiz/pib-plugin-ui";
import type { StepStatsRange } from "../db.js";
import { rangeParams, type CampaignResults, type ReplyView, type ResultCounts } from "../people.js";

export type ResultsRange = StepStatsRange;
export interface ResultsPayload { results: CampaignResults | null; replies: ReplyView[] | null }

function percent(part: number, sent: number): string {
  if (sent <= 0) return "—";
  return `${((part / sent) * 100).toFixed(1).replace(/\.0$/, "")}%`;
}

function Cell({ value, sent, strong }: { value: number; sent: number; strong?: boolean }) {
  return (
    <td style={{ padding: "8px 10px", textAlign: "right", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>
      <span style={{ fontWeight: strong ? 650 : 500 }}>{value}</span>
      {sent > 0 && !strong ? <span style={{ color: tokens.muted, fontSize: 12 }}> {percent(value, sent)}</span> : null}
    </td>
  );
}

function Row({ label, sub, counts, tracked, provider }: { label: string; sub?: string; counts: ResultCounts; tracked: boolean; provider: boolean }) {
  return (
    <tr style={{ borderTop: `1px solid ${tokens.border}` }}>
      <th scope="row" style={{ padding: "8px 10px", textAlign: "left", fontWeight: 600, minWidth: 160 }}>
        {label}
        {sub ? <span style={{ display: "block", fontWeight: 400, fontSize: 12.5, color: tokens.muted, overflowWrap: "anywhere" }}>{sub}</span> : null}
      </th>
      <Cell value={counts.sent} sent={0} strong />
      {provider ? <Cell value={counts.delivered} sent={counts.sent} /> : null}
      {tracked ? <Cell value={counts.opens} sent={counts.sent} /> : null}
      {tracked ? <Cell value={counts.clicks} sent={counts.sent} /> : null}
      <Cell value={counts.replies} sent={counts.sent} />
      <Cell value={counts.unsubscribes + counts.complaints} sent={counts.sent} />
      <Cell value={counts.bounces} sent={counts.sent} />
    </tr>
  );
}

export function ResultsTab({ results: first, replies: firstReplies, draft, delivery, load }: {
  results: CampaignResults | null;
  replies?: ReplyView[] | null;
  draft: boolean;
  delivery: string;
  /** Reads the numbers for a date range. Absent: no range picker. */
  load?: (range: ResultsRange) => Promise<ResultsPayload>;
}) {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [shown, setShown] = useState<ResultsPayload | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const latest = useRef(0);
  useEffect(() => {
    if (!load || (!from && !to)) { setShown(null); setFailed(false); return; }
    const mine = ++latest.current;
    setBusy(true);
    load(rangeParams(from, to))
      .then((payload) => { if (mine === latest.current) { setShown(payload); setFailed(false); } })
      .catch(() => { if (mine === latest.current) setFailed(true); })
      .finally(() => { if (mine === latest.current) setBusy(false); });
  }, [from, to, load]);
  const ranged = Boolean(from || to);
  const results = ranged && shown ? shown.results : first;
  const replies = ranged && shown ? shown.replies : firstReplies ?? null;
  if (draft) return <Note>Results show here once the campaign is launched and the first email has gone out.</Note>;
  if (!results) return <Note>The results could not be read just now. Reload the page.</Note>;
  const { totals, steps, tracked, providerReports } = results;
  const header = { padding: "8px 10px", textAlign: "right", fontSize: 12, fontWeight: 600, color: tokens.muted, whiteSpace: "nowrap" } as const;

  const stale = ranged && (busy || failed || !shown);
  return (
    <div style={{ display: "grid", gap: 14, minWidth: 0 }}>
      {load ? (
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "end" }}>
          <Field label="From"><Input type="date" value={from} max={to || undefined} onChange={(event) => setFrom(event.target.value)} /></Field>
          <Field label="To (this day counts)"><Input type="date" value={to} min={from || undefined} onChange={(event) => setTo(event.target.value)} /></Field>
          {ranged ? <Button type="button" variant="secondary" onClick={() => { setFrom(""); setTo(""); }}>All time</Button> : null}
        </div>
      ) : null}
      {failed ? <Note>The numbers for these dates could not be read just now. The figures below are for all time.</Note> : null}
      {stale && !failed ? <Note>Reading the numbers for these dates…</Note> : null}
      {totals.sent === 0 ? (
        <Note>
          No email has gone out yet, so there is nothing to measure.
          {delivery === "issue" ? " This campaign opens a task per email for the agent to send; a send is counted when that task is done." : ""}
        </Note>
      ) : null}
      <div style={{ display: "grid", gridTemplateColumns: fluidColumns(130), gap: 10 }}>
        <KpiCard size="sm" label="Emails sent" value={totals.sent} />
        <KpiCard size="sm" label="Replies" value={totals.replies} hint={`${percent(totals.replies, totals.sent)} of sent`} tone={totals.replies ? "ok" : "neutral"} />
        <KpiCard size="sm" label="Opted out" value={totals.unsubscribes} hint={`${percent(totals.unsubscribes, totals.sent)} of sent`} tone={totals.sent >= 20 && totals.unsubscribes / totals.sent > 0.02 ? "warn" : "neutral"} />
        {providerReports ? <KpiCard size="sm" label="Spam complaints" value={totals.complaints} hint={`${percent(totals.complaints, totals.sent)} of sent`} tone={totals.sent >= 20 && totals.complaints / totals.sent > 0.001 ? "bad" : "neutral"} /> : null}
        <KpiCard size="sm" label="Bounced" value={totals.bounces} hint={`${percent(totals.bounces, totals.sent)} of sent`} tone={totals.sent >= 20 && totals.bounces / totals.sent > 0.05 ? "bad" : "neutral"} />
        {totals.failed > 0 ? <KpiCard size="sm" label="Could not be sent" value={totals.failed} tone="bad" /> : null}
      </div>

      {steps.length > 0 ? (
        <div style={{ overflowX: "auto", border: `1px solid ${tokens.border}`, borderRadius: 10 }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr>
                <th scope="col" style={{ ...header, textAlign: "left" }}>Email</th>
                <th scope="col" style={header}>Sent</th>
                {providerReports ? <th scope="col" style={header}>Delivered</th> : null}
                {tracked ? <th scope="col" style={header}>Opened</th> : null}
                {tracked ? <th scope="col" style={header}>Clicked</th> : null}
                <th scope="col" style={header}>Replied</th>
                <th scope="col" style={header}>Opted out</th>
                <th scope="col" style={header}>Bounced</th>
              </tr>
            </thead>
            <tbody>
              {steps.map((step) => (
                step.versions ? (
                  <VersionRows key={step.position} number={step.number} subject={step.subject} subjectB={step.subjectB} a={step.versions.a} b={step.versions.b} tracked={tracked} provider={providerReports} />
                ) : (
                  <Row key={step.position} label={`Email ${step.number}`} sub={step.channel === "email" ? step.subject : step.channel === "sms" ? "SMS" : "WhatsApp"} counts={step.totals} tracked={tracked} provider={providerReports} />
                )
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      <Replies replies={replies} />

      <div style={{ display: "grid", gap: 4 }}>
        <span style={{ display: "inline-flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          <Pill tone="neutral">What is measured</Pill>
        </span>
        <Note>
          Sent, replies, opt-outs and bounces are always counted.
          {providerReports ? " The email provider also reports deliveries, soft bounces and spam complaints." : " Deliveries and spam complaints are only reported for emails sent through the email provider, not through a Gmail mailbox."}
          {tracked ? "" : " Opens and link clicks are not tracked yet."}
        </Note>
      </div>
    </div>
  );
}

function VersionRows({ number, subject, subjectB, a, b, tracked, provider }: { number: number; subject: string; subjectB: string | null; a: ResultCounts; b: ResultCounts; tracked: boolean; provider: boolean }) {
  return (
    <>
      <Row label={`Email ${number}, version A`} sub={subject} counts={a} tracked={tracked} provider={provider} />
      <Row label={`Email ${number}, version B`} sub={subjectB ?? undefined} counts={b} tracked={tracked} provider={provider} />
    </>
  );
}

function Note({ children }: { children: React.ReactNode }) {
  return <p style={{ margin: 0, fontSize: 13, color: tokens.muted, lineHeight: 1.5 }}>{children}</p>;
}

function Replies({ replies }: { replies: ReplyView[] | null }) {
  if (!replies) return <Note>The replies could not be read just now.</Note>;
  if (replies.length === 0) return <Note>No replies yet.</Note>;
  return (
    <div style={{ display: "grid", gap: 6 }}>
      <strong style={{ fontSize: 13 }}>Replies</strong>
      <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 6 }}>
        {replies.map((reply, index) => (
          <li key={`${reply.at ?? "x"}-${index}`} style={{ border: `1px solid ${tokens.border}`, borderRadius: 10, padding: "8px 10px", minWidth: 0 }}>
            <span style={{ display: "block", fontSize: 12, color: tokens.muted }}>
              {reply.at ? formatDate(reply.at) : "Date unknown"} · Email {reply.step}{reply.variant === "b" ? ", version B" : ""}
            </span>
            <span style={{ display: "block", fontSize: 13, overflowWrap: "anywhere", color: reply.text ? undefined : tokens.muted }}>
              {reply.text ?? "The text of this reply was not kept. Open it in the mailbox."}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
