import { useEffect, useRef, useState } from "react";
import { usePluginAction, type PluginPageProps } from "@paperclipai/plugin-sdk/ui";
import { Button, Input, Page, PageFrame, Form, Field, Section, Select, TextArea, errorText } from "@partnersinbiz/pib-plugin-ui";
import { toFormState, toSavePayload, validateForm, describeSecretStatus, type SettingsFormState } from "./settings-form.js";
import type { TelephonySettings } from "../settings.js";

// Server error keys that have an inline slot below; anything else goes in the banner.
const INLINE_ERROR_KEYS = [
  "maxCallsPerDay", "maxSmsPerDay", "maxWhatsappPerDay", "recordingRetentionDays",
  "allowedHours", "callerIds", "whatsappFrom", "usMessagingServiceSid", "voiceAllowedUserIds", "smsHolidays",
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
      return next;
    });
  };

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

  return (
    <PageFrame>
      <Page
        title="Telephony Settings"
        description={`Configuring: ${data.company.name ?? data.company.id}`}
        message={error ? error : saveSuccess ? "Saved" : syncNote ? syncNote : undefined}
        messageTone={error ? "bad" : saveSuccess || syncNote ? "good" : undefined}
      >
        <Form onSubmit={handleSave}>
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

          <Section title="Numbers">
            <div style={{ display: "grid", gap: 12 }}>
              <Field label="Caller IDs (one per line)">
                <TextArea value={form.callerIds} onChange={(e) => handleChange("callerIds", e.currentTarget.value)} disabled={saving} aria-invalid={!!fieldErrors.callerIds} />
                <FieldError message={fieldErrors.callerIds} />
              </Field>
              <Field label="WhatsApp from">
                <Input type="text" value={form.whatsappFrom} onChange={(e) => handleChange("whatsappFrom", e.currentTarget.value)} disabled={saving} aria-invalid={!!fieldErrors.whatsappFrom} />
                <FieldError message={fieldErrors.whatsappFrom} />
              </Field>
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
                <li key={row.name} style={{ display: "flex", justifyContent: "space-between", gap: 10, padding: "8px 10px", borderRadius: 8, background: "#f5f5f5" }}>
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
