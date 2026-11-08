import { useEffect, useRef, useState } from "react";
import { usePluginAction, type PluginPageProps } from "@paperclipai/plugin-sdk/ui";
import { Button, Input, Page, PageFrame, Form, Field, Pill, Section, Select, TextArea, errorText, tokens } from "@partnersinbiz/pib-plugin-ui";
import {
  toFormState, toSavePayload, validateForm, describeSecretStatus, describeVoiceReadiness, publicOrigin, voiceWebhookRows,
  emptyNumberRow, moveRow, setDefaultRow,
  type NumberRow, type SettingsFormState, type VoiceReadinessView,
} from "./settings-form.js";
import type { TelephonySettings } from "../settings.js";

// Server error keys that have an inline slot below; anything else goes in the banner.
const INLINE_ERROR_KEYS = [
  "maxCallsPerDay", "maxSmsPerDay", "maxWhatsappPerDay", "recordingRetentionDays",
  "allowedHours", "callerIds", "whatsappFrom", "usMessagingServiceSid", "voiceAllowedUserIds", "smsHolidays", "publicBaseUrl", "numbers",
];

function FieldError({ message }: { message?: string }) {
  if (!message) return null;
  return <div role="alert" style={{ marginTop: 4, fontSize: 12, color: "#ef4444", overflowWrap: "anywhere" }}>{message}</div>;
}

interface SettingsData {
  company: { id: string; name: string | null };
  settings: TelephonySettings;
  secrets: Record<string, "set" | "missing">;
  templateSyncRequestedAt: string | null;
  voice: VoiceReadinessView;
}

const READINESS_TONE = { set: "good", missing: "bad", optional: "neutral", off: "neutral" } as const;
const READINESS_TEXT = { set: "Set", missing: "Missing", optional: "Optional", off: "Off" } as const;

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // the URL is visible next to the button; selecting it still works
    }
  };
  return <Button type="button" variant="secondary" onClick={copy} style={{ padding: "0 10px", minHeight: 28 }}>{copied ? "Copied" : "Copy"}</Button>;
}

export function TelephonySettingsPage(_props: PluginPageProps) {
  const getSettings = usePluginAction("telephony.settings.get");
  const saveSettings = usePluginAction("telephony.settings.save");
  const syncTemplates = usePluginAction("telephony.settings.sync-templates");

  const [data, setData] = useState<SettingsData | null>(null);
  const [form, setForm] = useState<SettingsFormState | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [syncedAt, setSyncedAt] = useState<string | null>(null);
  const [syncNote, setSyncNote] = useState("");
  const successTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (successTimer.current) clearTimeout(successTimer.current);
  }, []);

  useEffect(() => {
    void (async () => {
      setLoading(true);
      setError("");
      try {
        const result = (await getSettings()) as SettingsData;
        setData(result);
        setForm(toFormState(result.settings));
      } catch (e) {
        setError(errorText(e));
      } finally {
        setLoading(false);
      }
    })();
  }, [getSettings]);

  if (loading || !data || !form) {
    return (
      <PageFrame>
        <Page title="Telephony Settings" description="Loading...">
          {error && <div style={{ padding: "10px 14px", borderRadius: 10, border: "1px solid #d97706", background: "rgba(217, 119, 6, 0.1)", color: "#d97706", fontSize: 13 }}>{error}</div>}
        </Page>
      </PageFrame>
    );
  }

  const handleChange = <K extends keyof SettingsFormState>(key: K, value: SettingsFormState[K]) => {
    setForm({ ...form, [key]: value });
    setFieldErrors((prev) => {
      const next = { ...prev };
      delete next[key];
      if (key === "allowedHoursStart" || key === "allowedHoursEnd") delete next.allowedHours;
      if (key === "numbers") for (const k of Object.keys(next)) if (k.startsWith("numbers")) delete next[k];
      return next;
    });
  };

  const updateRow = (index: number, patch: Partial<NumberRow>) => {
    const rows = form.numbers.map((r, i) => (i === index ? { ...r, ...patch } : r));
    handleChange("numbers", patch.isDefault ? setDefaultRow(rows, index) : rows);
  };
  const removeRow = (index: number) => {
    const rows = form.numbers.filter((_, i) => i !== index);
    handleChange("numbers", rows.some((r) => r.isDefault) || rows.length === 0 ? rows : setDefaultRow(rows, 0));
  };
  const addRow = () => handleChange("numbers", [...form.numbers, emptyNumberRow(form.numbers.length === 0)]);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (saving) return;
    setSaving(true);
    setError("");
    setFieldErrors({});
    setSaveSuccess(false);
    setSyncNote("");
    const clientErrors = validateForm(form);
    if (Object.keys(clientErrors).length > 0) {
      setFieldErrors(clientErrors);
      setError("Fix the highlighted fields");
      setSaving(false);
      return;
    }
    try {
      const result = (await saveSettings(toSavePayload(form))) as { ok: boolean; settings?: TelephonySettings; errors?: Record<string, string> };
      if (result.ok && result.settings) {
        setForm(toFormState(result.settings));
        setSaveSuccess(true);
        if (successTimer.current) clearTimeout(successTimer.current);
        successTimer.current = setTimeout(() => setSaveSuccess(false), 3000);
      } else if (result.errors) {
        setFieldErrors(result.errors);
        const other = Object.entries(result.errors).filter(([key]) => !INLINE_ERROR_KEYS.includes(key)).map(([, message]) => message);
        setError(other.length > 0 ? other.join("; ") : "Fix the highlighted fields");
      } else {
        setError("Save failed");
      }
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSaving(false);
    }
  };

  const handleSync = async () => {
    if (syncing) return;
    setSyncing(true);
    setError("");
    setSaveSuccess(false);
    try {
      const result = (await syncTemplates()) as { requestedAt?: string };
      setSyncedAt(result.requestedAt ?? new Date().toISOString());
      setSyncNote("Template sync requested");
    } catch (e) {
      setSyncNote("");
      setError(errorText(e));
    } finally {
      setSyncing(false);
    }
  };

  const secrets = describeSecretStatus(data.secrets);
  const lastSync = syncedAt ?? data.templateSyncRequestedAt;
  const readiness = describeVoiceReadiness(data.voice, data.secrets);
  const previewOrigin = publicOrigin(form.publicBaseUrl) ?? data.voice.publicBaseUrl;
  const webhookRows = previewOrigin ? voiceWebhookRows(previewOrigin) : [];
  const pageOrigin = typeof window !== "undefined" ? window.location.origin : "";

  return (
    <PageFrame>
      <Page
        title="Telephony Settings"
        description={`Configuring: ${data.company.name ?? data.company.id}`}
        message={error ? error : saveSuccess ? "Saved" : syncNote ? syncNote : undefined}
        messageTone={error ? "bad" : saveSuccess || syncNote ? "good" : undefined}
      >
        <Form onSubmit={handleSave}>
          <Section title="Voice calling" actions={<Pill tone={data.voice.ready ? "good" : "warn"} dot>{data.voice.ready ? "Ready" : "Not ready"}</Pill>}>
            <div style={{ display: "grid", gap: 12 }}>
              <p style={{ margin: 0, fontSize: 13, color: "#999" }}>
                The Dialer places calls through Twilio: it rings the salesperson's browser, then dials the contact from the company's number. Everything below must be in place first. Credentials are company secrets, picked once on the plugin's Configuration page (Plugins → CRM Telephony → Configuration); the names below are the fields there.
              </p>
              {data.voice.blockers.length > 0 && (
                <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, color: "#b45309", display: "grid", gap: 4 }}>
                  {data.voice.blockers.map((b) => <li key={b}>{b}</li>)}
                </ul>
              )}
              {data.voice.notes.length > 0 && (
                <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, color: tokens.muted, display: "grid", gap: 4 }}>
                  {data.voice.notes.map((b) => <li key={b}>{b}</li>)}
                </ul>
              )}
              <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "grid", gap: 6, fontSize: 13 }}>
                {readiness.map((row) => (
                  <li key={row.label} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, padding: "8px 10px", borderRadius: 8, background: tokens.secondary, border: `1px solid ${tokens.border}`, flexWrap: "wrap" }}>
                    <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>
                      {row.label}
                      {row.hint && <span style={{ display: "block", fontSize: 12, color: tokens.muted }}>{row.hint}</span>}
                    </span>
                    <Pill tone={READINESS_TONE[row.status]} size="sm">{READINESS_TEXT[row.status]}</Pill>
                  </li>
                ))}
              </ul>
              <Field label="Public base URL (where Twilio reaches this Paperclip)">
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <Input
                    type="url"
                    value={form.publicBaseUrl}
                    onChange={(e) => handleChange("publicBaseUrl", e.currentTarget.value)}
                    disabled={saving}
                    placeholder="https://paperclip.example.com"
                    aria-invalid={!!fieldErrors.publicBaseUrl}
                    style={{ flex: "1 1 240px" }}
                  />
                  {pageOrigin && (
                    <Button type="button" variant="secondary" disabled={saving} onClick={() => handleChange("publicBaseUrl", pageOrigin)}>Use this address</Button>
                  )}
                </div>
                <FieldError message={fieldErrors.publicBaseUrl} />
                <p style={{ margin: "6px 0 0", fontSize: 12, color: "#999" }}>Saved with the form. Status callbacks are signed against this address, so it must be the address Twilio can reach, not localhost.</p>
              </Field>
              {webhookRows.length > 0 && (
                <div style={{ display: "grid", gap: 8 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: tokens.muted, textTransform: "uppercase", letterSpacing: "0.03em" }}>Webhook addresses</div>
                  {webhookRows.map((row) => (
                    <div key={row.key} style={{ display: "grid", gap: 4, padding: "8px 10px", borderRadius: 8, border: `1px solid ${tokens.border}`, background: tokens.secondary }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                        <span style={{ fontSize: 13, fontWeight: 600 }}>{row.label}</span>
                        <CopyButton text={row.url} />
                      </div>
                      <code style={{ fontSize: 12, overflowWrap: "anywhere" }}>{row.url}</code>
                      <span style={{ fontSize: 12, color: tokens.muted }}>{row.note}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </Section>

          <Section title="Features">
            <div style={{ display: "grid", gap: 12 }}>
              {(["recordingEnabled", "smsEnabled", "whatsappEnabled"] as const).map((key) => (
                <label key={key} style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer", fontSize: 13 }}>
                  <input type="checkbox" checked={form[key]} onChange={(e) => handleChange(key, e.currentTarget.checked)} disabled={saving} />
                  <span>{key === "recordingEnabled" ? "Recording" : key === "smsEnabled" ? "SMS" : "WhatsApp"}</span>
                </label>
              ))}
            </div>
          </Section>

          <Section title="Daily Caps & Hours">
            <div style={{ display: "grid", gap: 12, gridTemplateColumns: "1fr 1fr" }}>
              {(["maxCallsPerDay", "maxSmsPerDay", "maxWhatsappPerDay", "recordingRetentionDays"] as const).map((key) => (
                <Field key={key} label={key === "maxCallsPerDay" ? "Max calls" : key === "maxSmsPerDay" ? "Max SMS" : key === "maxWhatsappPerDay" ? "Max WhatsApp" : "Retention days"}>
                  <Input type="number" value={form[key]} onChange={(e) => handleChange(key, e.currentTarget.value)} disabled={saving} min="0" aria-invalid={!!fieldErrors[key]} />
                  <FieldError message={fieldErrors[key]} />
                </Field>
              ))}
              <Field label="Start (HH:MM)">
                <Input type="text" value={form.allowedHoursStart} onChange={(e) => handleChange("allowedHoursStart", e.currentTarget.value)} disabled={saving} aria-invalid={!!fieldErrors.allowedHours} />
              </Field>
              <Field label="End (HH:MM)">
                <Input type="text" value={form.allowedHoursEnd} onChange={(e) => handleChange("allowedHoursEnd", e.currentTarget.value)} disabled={saving} aria-invalid={!!fieldErrors.allowedHours} />
              </Field>
              <div style={{ gridColumn: "1 / -1" }}><FieldError message={fieldErrors.allowedHours} /></div>
              <div style={{ gridColumn: "1 / -1", fontSize: 12, color: "#999" }}>Timezone: Africa/Johannesburg</div>
            </div>
          </Section>

          <Section title="Numbers" actions={<Button type="button" variant="secondary" onClick={addRow} disabled={saving}>Add number</Button>}>
            <div style={{ display: "grid", gap: 12 }}>
              <p style={{ margin: 0, fontSize: 13, color: tokens.muted }}>
                The company's Twilio numbers. A call or message to a lead uses the enabled number whose region matches the lead's country calling code, else the default. Regions are calling codes (27 for South Africa, 1 for the US and Canada, 44 for the UK); a number with no region is used only as the default.
              </p>
              {data.voice.numbers.source === "secrets" && form.numbers.length > 0 && (
                <p style={{ margin: 0, fontSize: 12, color: "#b45309" }}>These rows were read from the old secrets. Press Save once to keep them here; after that the secrets are no longer read.</p>
              )}
              {form.numbers.length === 0 && <p style={{ margin: 0, fontSize: 13, color: tokens.muted }}>No numbers yet. Add the first one; it becomes the default.</p>}
              {form.numbers.map((row, index) => (
                <div key={index} role="group" aria-label={`Number ${index + 1}`} style={{ display: "grid", gap: 8, padding: "10px 12px", borderRadius: 10, border: `1px solid ${tokens.border}`, background: tokens.secondary, opacity: row.enabled ? 1 : 0.7 }}>
                  <div style={{ display: "grid", gap: 8, gridTemplateColumns: "minmax(140px, 1fr) minmax(140px, 1fr) minmax(100px, 0.8fr)" }}>
                    <Field label="Number (E.164)">
                      <Input type="tel" value={row.e164} placeholder="+27105550100" onChange={(e) => updateRow(index, { e164: e.currentTarget.value })} disabled={saving} aria-invalid={!!fieldErrors[`numbers.${index}`]} />
                    </Field>
                    <Field label="Label">
                      <Input type="text" value={row.label} placeholder="PiB Cape Town" onChange={(e) => updateRow(index, { label: e.currentTarget.value })} disabled={saving} />
                    </Field>
                    <Field label="Regions (calling codes)">
                      <Input type="text" value={row.regions} placeholder="27" onChange={(e) => updateRow(index, { regions: e.currentTarget.value })} disabled={saving} />
                    </Field>
                  </div>
                  <div style={{ display: "flex", gap: 14, flexWrap: "wrap", alignItems: "center", fontSize: 13 }}>
                    {(["voice", "sms", "whatsapp"] as const).map((p) => (
                      <label key={p} style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
                        <input type="checkbox" checked={row[p]} onChange={(e) => updateRow(index, { [p]: e.currentTarget.checked } as Partial<NumberRow>)} disabled={saving} />
                        {p === "voice" ? "Voice" : p === "sms" ? "SMS" : "WhatsApp"}
                      </label>
                    ))}
                    <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
                      <input type="checkbox" checked={row.enabled} onChange={(e) => updateRow(index, { enabled: e.currentTarget.checked })} disabled={saving} />
                      Enabled
                    </label>
                    <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
                      <input type="radio" name="default-number" checked={row.isDefault} onChange={() => updateRow(index, { isDefault: true })} disabled={saving || !row.enabled} />
                      Default
                    </label>
                    <span style={{ flex: 1 }} />
                    <Button type="button" variant="secondary" onClick={() => handleChange("numbers", moveRow(form.numbers, index, -1))} disabled={saving || index === 0} aria-label="Move up" style={{ padding: "0 10px", minHeight: 28 }}>↑</Button>
                    <Button type="button" variant="secondary" onClick={() => handleChange("numbers", moveRow(form.numbers, index, 1))} disabled={saving || index === form.numbers.length - 1} aria-label="Move down" style={{ padding: "0 10px", minHeight: 28 }}>↓</Button>
                    <Button type="button" variant="secondary" onClick={() => removeRow(index)} disabled={saving} style={{ padding: "0 10px", minHeight: 28 }}>Remove</Button>
                  </div>
                  <FieldError message={fieldErrors[`numbers.${index}`]} />
                </div>
              ))}
              <FieldError message={fieldErrors.numbers} />
              <Field label="US Messaging Service SID">
                <Input type="text" value={form.usMessagingServiceSid} onChange={(e) => handleChange("usMessagingServiceSid", e.currentTarget.value)} disabled={saving} aria-invalid={!!fieldErrors.usMessagingServiceSid} />
                <FieldError message={fieldErrors.usMessagingServiceSid} />
              </Field>
            </div>
          </Section>

          <Section title="Campaign & Allowlist">
            <div style={{ display: "grid", gap: 12, gridTemplateColumns: "1fr 1fr" }}>
              <Field label="10DLC Status">
                <Select value={form.usSmsCampaignStatus} onChange={(e) => handleChange("usSmsCampaignStatus", e.currentTarget.value as any)} disabled={saving}>
                  <option value="none">None</option>
                  <option value="pending">Pending</option>
                  <option value="approved">Approved</option>
                  <option value="rejected">Rejected</option>
                </Select>
              </Field>
              <div />
              <Field label="Voice user IDs (one per line)">
                <TextArea value={form.voiceAllowedUserIds} onChange={(e) => handleChange("voiceAllowedUserIds", e.currentTarget.value)} disabled={saving} style={{ gridColumn: "1 / -1" }} aria-invalid={!!fieldErrors.voiceAllowedUserIds} />
                <FieldError message={fieldErrors.voiceAllowedUserIds} />
              </Field>
              <Field label="SMS holidays (ISO dates)">
                <TextArea value={form.smsHolidays} onChange={(e) => handleChange("smsHolidays", e.currentTarget.value)} disabled={saving} style={{ gridColumn: "1 / -1" }} aria-invalid={!!fieldErrors.smsHolidays} />
                <FieldError message={fieldErrors.smsHolidays} />
              </Field>
            </div>
          </Section>

          <Section title="Secrets">
            <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "grid", gap: 6, fontSize: 13 }}>
              {secrets.map((row) => (
                <li key={row.name} style={{ display: "flex", justifyContent: "space-between", gap: 10, padding: "8px 10px", borderRadius: 8, background: tokens.secondary, border: `1px solid ${tokens.border}` }}>
                  <span>{row.label}</span>
                  <span style={{ fontSize: 12, color: row.status === "set" ? "#10b981" : "#ef4444" }}>{row.status === "set" ? "Set" : "Missing"}</span>
                </li>
              ))}
            </ul>
            <p style={{ margin: "10px 0 0", fontSize: 12, color: "#999" }}>Managed in Paperclip secrets, per company</p>
          </Section>

          <Section title="Template Sync" actions={<Button type="button" variant="secondary" onClick={handleSync} disabled={syncing || saving}>{syncing ? "…" : "Request"}</Button>}>
            <p style={{ margin: 0, fontSize: 13, color: "#999" }}>Sync call flow templates to agents</p>
            {lastSync && <p style={{ margin: "8px 0 0", fontSize: 12, color: "#999", overflowWrap: "anywhere" }}>Last requested: {new Date(lastSync).toLocaleString()}</p>}
          </Section>

          <div style={{ display: "flex", justifyContent: "space-between", gap: 10, marginTop: 12 }}>
            <div />
            <Button type="submit" disabled={saving}>{saving ? "Saving…" : "Save"}</Button>
          </div>
        </Form>
      </Page>
    </PageFrame>
  );
}
