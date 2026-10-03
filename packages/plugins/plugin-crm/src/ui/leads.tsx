/**
 * The client's lead forms: forms on the client's website that take enquiries
 * into the CRM as the client's own leads. A person makes one, copies its
 * snippet to whoever maintains the site, and sees how it is doing.
 */
import { useState, type FormEvent } from "react";
import { Button, CircleAlert, EmptyState, Field, Form, Input, Inbox, Modal, Pill, SectionCard, Select, tokens } from "@partnersinbiz/pib-plugin-ui";
import { formEditable, formFacts, FORM_STATUS_LABEL, formStatusTone, type CreatedLeadForm, type LeadFormView } from "./leads-view.js";
import { whenText } from "./parts.js";

const muted = { margin: 0, fontSize: 12.5, color: tokens.muted, lineHeight: 1.45 } as const;
const smallButton = { height: 28, fontSize: 12 } as const;

/** Copies text; the old way when the browser blocks the clipboard in a frame. */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const area = document.createElement("textarea");
      area.value = text;
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(area);
      return ok;
    } catch {
      return false;
    }
  }
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  return (
    <Button
      type="button"
      variant="secondary"
      style={smallButton}
      onClick={() => {
        void copyText(text).then((ok) => {
          setState(ok ? "copied" : "failed");
          setTimeout(() => setState("idle"), 2000);
        });
      }}
    >
      {state === "copied" ? "Copied" : state === "failed" ? "Select and copy it by hand" : label}
    </Button>
  );
}

function Code({ children }: { children: string }) {
  return (
    <pre style={{ margin: 0, padding: 10, borderRadius: 8, border: `1px solid ${tokens.border}`, background: tokens.secondary, fontSize: 12, lineHeight: 1.5, overflowX: "auto", whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
      {children}
    </pre>
  );
}

export function LeadFormsCard({
  forms,
  sites,
  onCreate,
  onUpdate,
  onRotate,
  onSecret,
}: {
  forms: LeadFormView[];
  sites: Array<{ id: string; url: string; label: string | null }>;
  onCreate: (params: Record<string, unknown>) => Promise<CreatedLeadForm | null>;
  onUpdate: (params: Record<string, unknown>, success: string) => Promise<boolean>;
  onRotate: (sourceId: string, serverSecret: boolean) => Promise<{ serverSecret?: string; serverSecretNote?: string; oldKeyValidUntil?: string } | null>;
  /** A person makes (or replaces) the signing secret without changing the key. Shown once. */
  onSecret: (sourceId: string) => Promise<{ serverSecret?: string; serverSecretNote?: string } | null>;
}) {
  const [making, setMaking] = useState(false);
  const [label, setLabel] = useState("");
  const [siteId, setSiteId] = useState("");
  const [serverSecret, setServerSecret] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [secret, setSecret] = useState<{ form: string; value: string; note: string } | null>(null);
  const [switching, setSwitching] = useState<LeadFormView | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy("new");
    const result = await onCreate({ label: label || undefined, siteId: siteId || undefined, serverSecret });
    setBusy(null);
    if (!result) return;
    setMaking(false);
    setLabel("");
    setSiteId("");
    setServerSecret(false);
    if (result.serverSecret) setSecret({ form: result.source.label, value: result.serverSecret, note: result.serverSecretNote ?? "Shown once." });
  }

  async function rotate(form: LeadFormView, withSecret: boolean) {
    setBusy(form.id);
    const result = await onRotate(form.id, withSecret);
    setBusy(null);
    if (result?.serverSecret) setSecret({ form: form.label, value: result.serverSecret, note: result.serverSecretNote ?? "Shown once." });
  }

  async function makeSecret(form: LeadFormView) {
    setBusy(form.id);
    const result = await onSecret(form.id);
    setBusy(null);
    if (result?.serverSecret) setSecret({ form: form.label, value: result.serverSecret, note: result.serverSecretNote ?? "Shown once." });
  }

  return (
    <SectionCard
      title={`Lead forms (${forms.length})`}
      icon={Inbox}
      subtitle="Forms on this client's website. A lead through one is the client's lead: kept on this page and handed to them, never added to our contacts (POPIA)."
      actions={<Button type="button" variant="secondary" style={smallButton} onClick={() => setMaking(true)}>+ Make a form</Button>}
    >
      {secret ? (
        <div role="status" style={{ display: "grid", gap: 8, padding: 12, marginBottom: 12, borderRadius: 10, border: `1px solid ${tokens.border}`, minWidth: 0 }}>
          <strong style={{ fontSize: 13 }}>Signing secret for {secret.form}</strong>
          <Code>{secret.value}</Code>
          <p style={muted}>{secret.note}</p>
          <div style={{ display: "flex", gap: 8 }}>
            <CopyButton text={secret.value} label="Copy the secret" />
            <Button type="button" variant="secondary" style={smallButton} onClick={() => setSecret(null)}>I have saved it</Button>
          </div>
        </div>
      ) : null}
      {forms.length === 0 ? (
        <EmptyState
          compact
          icon={Inbox}
          title="No lead form yet"
          description="Make a form, then give its snippet to whoever looks after the client's website. The first lead shows on this page."
          action={<Button type="button" onClick={() => setMaking(true)}>Make a form</Button>}
        />
      ) : (
        <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "grid", gap: 12 }}>
          {forms.map((form) => (
            <li key={form.id} style={{ display: "grid", gap: 8, padding: 12, borderRadius: 10, border: `1px solid ${tokens.border}`, minWidth: 0 }}>
              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", minWidth: 0 }}>
                <strong style={{ fontSize: 13.5, overflowWrap: "anywhere" }}>{form.label}</strong>
                <Pill size="sm" tone={formStatusTone(form.status)} dot>{FORM_STATUS_LABEL[form.status]}</Pill>
                {form.canary ? <Pill size="sm" tone="info">Canary test</Pill> : null}
              </div>
              <p style={muted}>{formFacts(form, whenText)}</p>
              {(form.warnings ?? []).map((warning) => (
                <p key={warning} style={{ ...muted, color: tokens.tones.warn.fg, display: "flex", gap: 6 }}>
                  <CircleAlert size={14} style={{ flexShrink: 0, marginTop: 2 }} aria-hidden="true" />
                  {warning}
                </p>
              ))}
              {form.embed ? (
                <details>
                  <summary style={{ cursor: "pointer", fontSize: 13, fontWeight: 600 }}>The snippet and how to install it</summary>
                  <div style={{ display: "grid", gap: 8, marginTop: 8 }}>
                    <Code>{form.embed.snippet}</Code>
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                      <CopyButton text={form.embed.snippet} label="Copy the snippet" />
                      <CopyButton text={form.embed.curl} label="Copy a test command" />
                    </div>
                    <ol style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 6, fontSize: 12.5, color: tokens.muted }}>
                      {form.embed.steps.slice(1).map((step) => <li key={step}>{step}</li>)}
                    </ol>
                  </div>
                </details>
              ) : form.embedNote ? (
                <p style={muted}>{form.embedNote}</p>
              ) : null}
              {formEditable(form) ? (
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  {form.status === "active" ? (
                    <Button type="button" variant="secondary" style={smallButton} disabled={busy === form.id} onClick={() => void onUpdate({ sourceId: form.id, status: "paused" }, "Form paused")}>Pause</Button>
                  ) : (
                    <Button type="button" variant="secondary" style={smallButton} disabled={busy === form.id} onClick={() => void onUpdate({ sourceId: form.id, status: "active" }, "Form is taking leads again")}>Resume</Button>
                  )}
                  <Button type="button" variant="secondary" style={smallButton} disabled={busy === form.id} onClick={() => void rotate(form, false)}>
                    {busy === form.id ? "Working…" : "New key"}
                  </Button>
                  <Button type="button" variant="secondary" style={smallButton} disabled={busy === form.id} onClick={() => void makeSecret(form)}>
                    {form.serverSecret.set ? "New signing secret" : "Make a signing secret"}
                  </Button>
                  {form.serverSecret.set ? (
                    <Button type="button" variant="secondary" style={smallButton} disabled={busy === form.id} onClick={() => void rotate(form, true)}>
                      New key and secret
                    </Button>
                  ) : null}
                  <Button type="button" variant="secondary" style={smallButton} onClick={() => setSwitching(form)}>Switch off for good</Button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      <Modal open={making} title="Make a lead form" description="One form for one page or site. You get a snippet to install." onClose={() => { if (busy !== "new") setMaking(false); }}>
        <Form onSubmit={(event) => void submit(event)}>
          <Field label="Name">
            <Input value={label} onChange={(event) => setLabel(event.target.value)} placeholder="Contact form, Quote request" />
          </Field>
          {sites.length > 0 ? (
            <Field label="Website">
              <Select value={siteId} onChange={(event) => setSiteId(event.target.value)}>
                <option value="">Not one of the listed websites</option>
                {sites.map((site) => <option key={site.id} value={site.id}>{site.label ? `${site.label}: ` : ""}{site.url.replace(/^https?:\/\//, "")}</option>)}
              </Select>
            </Field>
          ) : null}
          <label style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 13 }}>
            <input type="checkbox" checked={serverSecret} onChange={(event) => setServerSecret(event.target.checked)} style={{ marginTop: 3 }} />
            <span>The client's own server will send the form (WordPress PHP, a Next.js route): make a signing secret too.</span>
          </label>
          <p style={muted}>The form's tick box asks whether the client may email the person. It starts unticked.</p>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", flexWrap: "wrap" }}>
            <Button type="button" variant="secondary" onClick={() => setMaking(false)} disabled={busy === "new"}>Cancel</Button>
            <Button type="submit" disabled={busy === "new"}>{busy === "new" ? "Making…" : "Make the form"}</Button>
          </div>
        </Form>
      </Modal>

      <Modal
        open={switching !== null}
        title="Switch this form off for good?"
        description={switching ? `${switching.label} stops taking leads and cannot be turned on again. Its leads stay on this page. A paused form can be resumed; this cannot.` : undefined}
        onClose={() => setSwitching(null)}
        footer={(
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", flexWrap: "wrap" }}>
            <Button type="button" variant="secondary" onClick={() => setSwitching(null)}>Keep it</Button>
            <Button
              type="button"
              onClick={() => {
                const form = switching;
                setSwitching(null);
                if (form) void onUpdate({ sourceId: form.id, status: "revoked" }, "Form switched off");
              }}
            >
              Switch it off
            </Button>
          </div>
        )}
      >
        <p style={muted}>Pause it instead if you may want it back. To replace it, make a new form with a new key.</p>
      </Modal>
    </SectionCard>
  );
}
