/**
 * The Agreements and Growth card on a client's page: whether e-sign is on and the client's documents, where its enquiries came from,
 * and its site visit counters. Everything shown is read by the worker (`agreements` and `growth` in the client workspace); every
 * button runs a page action `crm.<tool>`. Turning e-sign on is a person's decision, and a document goes out only through an email a
 * person approves. The snippet a counter needs is text for the client's developer: nothing here installs it.
 */
import { useState, type FormEvent } from "react";
import { Button, EmptyState, Field, FileText, Form, Input, Modal, Pill, SectionCard, Select, TextArea, tokens } from "@partnersinbiz/pib-plugin-ui";
import {
  canSend,
  canWithdraw,
  channelLine,
  docTone,
  DOC_STATUS_LABEL,
  esignLine,
  KIND_LABEL,
  orderDocs,
  siteKeyLine,
  valueText,
  type AgreementsView,
  type GrowthView,
} from "./agreements-view.js";

const muted = { margin: 0, fontSize: 12.5, color: tokens.muted, lineHeight: 1.45 } as const;
const smallButton = { height: 28, fontSize: 12 } as const;
const rowStyle = { display: "grid", gap: 6, padding: 10, borderRadius: 10, border: `1px solid ${tokens.border}`, minWidth: 0 } as const;

type Run = (action: string, params: Record<string, unknown>, success: string) => Promise<boolean>;

export interface CreatedKey {
  created?: boolean;
  note?: string;
  key?: { label?: string; consentMode?: string; install?: { snippet?: string; steps?: string[]; doNotInstallYourself?: string } };
}

function Heading({ children, action }: { children: string; action?: React.ReactNode }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, marginTop: 14 }}>
      <strong style={{ fontSize: 13 }}>{children}</strong>
      {action}
    </div>
  );
}

export function ClientAgreementsCard({
  agreements,
  growth,
  clientRef,
  clientName,
  onRun,
  onCreateKey,
}: {
  agreements: AgreementsView | null;
  growth: GrowthView | null;
  clientRef: string;
  clientName: string;
  onRun: Run;
  onCreateKey: (params: Record<string, unknown>) => Promise<CreatedKey | null>;
}) {
  const now = Date.now();
  const [busy, setBusy] = useState<string | null>(null);
  const [turnOn, setTurnOn] = useState(false);
  const [reviewed, setReviewed] = useState(false);
  const [voiding, setVoiding] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [keyForm, setKeyForm] = useState(false);
  const [keyLabel, setKeyLabel] = useState("");
  const [siteUrl, setSiteUrl] = useState("");
  const [consentMode, setConsentMode] = useState("anonymous");
  const [created, setCreated] = useState<CreatedKey | null>(null);

  async function run(key: string, action: string, params: Record<string, unknown>, success: string): Promise<boolean> {
    setBusy(key);
    const ok = await onRun(action, params, success);
    setBusy(null);
    return ok;
  }

  async function enable(event: FormEvent) {
    event.preventDefault();
    const ok = await run("esign", "enable-esign", { client: clientRef, confirm: true, templatesReviewed: reviewed }, "E-sign is on for this client. A document still goes out only through an email a person approves.");
    if (ok) {
      setTurnOn(false);
      setReviewed(false);
    }
  }

  async function withdraw(event: FormEvent) {
    event.preventDefault();
    if (!voiding) return;
    const ok = await run(voiding, "void-sign-document", { documentId: voiding, reason: reason.trim() }, "Document withdrawn: its link no longer works");
    if (ok) {
      setVoiding(null);
      setReason("");
    }
  }

  async function makeKey(event: FormEvent) {
    event.preventDefault();
    setBusy("key");
    const result = await onCreateKey({ client: clientRef, label: keyLabel.trim() || undefined, siteUrl: siteUrl.trim() || undefined, consentMode });
    setBusy(null);
    if (result) {
      setKeyForm(false);
      setKeyLabel("");
      setSiteUrl("");
      setCreated(result);
    }
  }

  const docs = agreements ? orderDocs(agreements.documents) : [];
  const line = agreements ? esignLine(agreements) : null;
  const keys = growth?.siteKeys ?? [];
  const channels = growth?.channels ?? [];
  const nothing = !agreements && channels.length === 0 && keys.length === 0;

  return (
    <SectionCard title="Agreements and growth" subtitle="Documents to sign, where enquiries came from, and site visit counts" icon={FileText}>
      {agreements && line ? (
        <>
          <Heading
            action={
              agreements.canary ? undefined : agreements.allowed ? (
                <Button type="button" variant="secondary" style={smallButton} disabled={busy === "esign"} onClick={() => void run("esign", "disable-esign", { client: clientRef }, "E-sign is off: no new document can be made or sent. Documents already sent stay as they are.")}>Turn off</Button>
              ) : (
                <Button type="button" variant="secondary" style={smallButton} onClick={() => setTurnOn(true)}>Turn on e-sign…</Button>
              )
            }
          >
            Documents to sign
          </Heading>
          <p style={{ ...muted, color: line.tone === "warn" ? tokens.tones.warn.fg : tokens.muted }}>{line.text}</p>
          {docs.length === 0 ? <p style={muted}>No documents yet. The Deal Desk or the Account Manager prepares one from a template; it is sent only through an email a person approves.</p> : null}
          <ul style={{ margin: "6px 0 0", padding: 0, listStyle: "none", display: "grid", gap: 8 }}>
            {docs.slice(0, 8).map((doc) => {
              const value = valueText(doc);
              return (
                <li key={doc.documentId} style={rowStyle}>
                  <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                    <strong style={{ fontSize: 13, overflowWrap: "anywhere" }}>{doc.title}</strong>
                    <Pill size="sm" tone="neutral">{KIND_LABEL[doc.kind] ?? doc.kind}</Pill>
                    <Pill size="sm" tone={docTone(doc.status)} dot>{DOC_STATUS_LABEL[doc.status]}</Pill>
                    {value ? <span style={{ fontSize: 12.5, color: tokens.muted }}>{value}</span> : null}
                  </div>
                  <p style={muted}>{doc.statusLine}</p>
                  {canSend(doc, agreements.allowed) || canWithdraw(doc) ? (
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                      {canSend(doc, agreements.allowed) ? (
                        <Button type="button" variant="secondary" style={smallButton} disabled={busy === doc.documentId} onClick={() => void run(doc.documentId, "send-for-signature", { documentId: doc.documentId }, "Drafted for approval: a person approves the email, and only then is the private link made and sent")}>Send for signature</Button>
                      ) : null}
                      {canWithdraw(doc) ? <Button type="button" variant="secondary" style={smallButton} onClick={() => setVoiding(doc.documentId)}>Withdraw</Button> : null}
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </>
      ) : null}

      <Heading>{`Where enquiries came from (last ${growth?.days ?? 90} days)`}</Heading>
      {channels.length === 0 ? (
        <p style={muted}>No enquiry with a channel yet. A lead form on the client's site, or what the client tells us about its leads, fills this in.</p>
      ) : (
        <ul style={{ margin: "6px 0 0", padding: 0, listStyle: "none", display: "grid", gap: 6 }}>
          {channels.map((row) => (
            <li key={row.channel} style={{ display: "grid", gap: 2 }}>
              <span style={{ fontSize: 13, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <strong>{row.label}</strong>
                {row.channel === "unattributed" ? <Pill size="sm" tone="warn">Not recorded</Pill> : null}
              </span>
              <span style={muted}>{channelLine(row)}</span>
            </li>
          ))}
        </ul>
      )}
      {channels.length > 0 ? <p style={{ ...muted, marginTop: 6 }}>Each sale is credited once. A lead with nothing on record stays unattributed: it is never guessed.</p> : null}

      <Heading action={<Button type="button" variant="secondary" style={smallButton} onClick={() => setKeyForm(true)}>+ Site counter</Button>}>Site visit counts</Heading>
      {growth?.site ? <p style={muted}>Last 30 days: {growth.site.visits} visits, {growth.site.pageviews} pages viewed, {growth.site.conversions} conversions. Counts are estimates.</p> : null}
      {keys.length === 0 ? <p style={muted}>No counter. A counter is a tiny script that counts visits and actions with no personal data. Making one only creates the text: putting it on the client's site is a change to their site, so it needs the owner's OK.</p> : null}
      <ul style={{ margin: "6px 0 0", padding: 0, listStyle: "none", display: "grid", gap: 6 }}>
        {keys.map((key) => {
          const state = siteKeyLine(key, now);
          return (
            <li key={key.id} style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", justifyContent: "space-between" }}>
              <span style={{ display: "grid", gap: 2, minWidth: 0 }}>
                <span style={{ fontSize: 13, overflowWrap: "anywhere" }}>{key.label}{key.site ? ` · ${key.site.replace(/^https?:\/\//, "")}` : ""}</span>
                <span style={{ ...muted, color: state.tone === "warn" ? tokens.tones.warn.fg : tokens.muted }}>{state.text}</span>
              </span>
              <Button type="button" variant="secondary" style={smallButton} disabled={busy === key.id} onClick={() => void run(key.id, "update-event-key", { keyId: key.id, status: key.status === "paused" ? "active" : "paused" }, key.status === "paused" ? "Counting again" : "Counter paused")}>{key.status === "paused" ? "Resume" : "Pause"}</Button>
            </li>
          );
        })}
      </ul>

      {nothing ? <EmptyState compact title="Nothing yet" description="Documents, channels and site counts for this client appear here." /> : null}

      <Modal open={turnOn} title={`Turn on e-sign for ${clientName}`} description="Agents can then prepare documents for this client to sign. Each one still goes out only through an email you approve." onClose={() => { if (busy !== "esign") setTurnOn(false); }}>
        <Form onSubmit={(event) => void enable(event)}>
          <p style={muted}>A signature here is a typed name given with the signer's consent: a basic electronic signature, not an advanced one. The templates are drafts that no lawyer has reviewed unless you say so below. A document the law requires in ink or with an advanced signature must not use this.</p>
          <label style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 13 }}>
            <input type="checkbox" checked={reviewed} onChange={(event) => setReviewed(event.target.checked)} style={{ marginTop: 3 }} />
            <span>A lawyer has reviewed the templates for this client's use.</span>
          </label>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <Button type="button" variant="secondary" onClick={() => setTurnOn(false)} disabled={busy === "esign"}>Cancel</Button>
            <Button type="submit" disabled={busy === "esign"}>{busy === "esign" ? "Turning on…" : "Turn on e-sign"}</Button>
          </div>
        </Form>
      </Modal>

      <Modal open={voiding !== null} title="Withdraw this document" description="Its link stops working at once. Say why, in a sentence." onClose={() => setVoiding(null)}>
        <Form onSubmit={(event) => void withdraw(event)}>
          <Field label="Why is it withdrawn?"><TextArea value={reason} onChange={(event) => setReason(event.target.value)} rows={3} required /></Field>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <Button type="button" variant="secondary" onClick={() => setVoiding(null)}>Cancel</Button>
            <Button type="submit" disabled={reason.trim().length < 5 || busy === voiding}>Withdraw</Button>
          </div>
        </Form>
      </Modal>

      <Modal open={keyForm} title="Make a site visit counter" description="This only creates the text for the site. Nothing is installed." onClose={() => { if (busy !== "key") setKeyForm(false); }}>
        <Form onSubmit={(event) => void makeKey(event)}>
          <Field label="Name (optional)"><Input value={keyLabel} onChange={(event) => setKeyLabel(event.target.value)} placeholder={`${clientName} website`} /></Field>
          <Field label="The site's address (https, optional)"><Input value={siteUrl} onChange={(event) => setSiteUrl(event.target.value)} placeholder="https://www.example.co.za" /></Field>
          <Field label="Cookie banner">
            <Select value={consentMode} onChange={(event) => setConsentMode(event.target.value)}>
              <option value="anonymous">Counts only, nothing remembered on the visitor's device</option>
              <option value="required">Count nothing until the site's own banner says yes</option>
            </Select>
          </Field>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <Button type="button" variant="secondary" onClick={() => setKeyForm(false)} disabled={busy === "key"}>Cancel</Button>
            <Button type="submit" disabled={busy === "key"}>{busy === "key" ? "Making…" : "Make the counter"}</Button>
          </div>
        </Form>
      </Modal>

      <Modal open={created !== null} title="The counter's text" description={created?.key?.install?.doNotInstallYourself ?? "Give this to the client's developer, or put it in a pull request through the client's repo project, after the owner's OK."} onClose={() => setCreated(null)}>
        {created?.note ? <p style={muted}>{created.note}</p> : null}
        {created?.key?.install?.snippet ? (
          <TextArea readOnly rows={5} value={created.key.install.snippet} onFocus={(event) => event.currentTarget.select()} style={{ fontFamily: "ui-monospace, Menlo, monospace", fontSize: 12 }} />
        ) : <p style={muted}>The address the counter reports to is not set up yet, so there is no snippet. The plugin's public address must be set first.</p>}
        <ol style={{ margin: "8px 0 0", paddingLeft: 18, display: "grid", gap: 2, fontSize: 12.5, color: tokens.muted }}>
          {(created?.key?.install?.steps ?? []).slice(0, 6).map((step, index) => <li key={index}>{step}</li>)}
        </ol>
        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 10 }}>
          <Button type="button" onClick={() => setCreated(null)}>Done</Button>
        </div>
      </Modal>
    </SectionCard>
  );
}
