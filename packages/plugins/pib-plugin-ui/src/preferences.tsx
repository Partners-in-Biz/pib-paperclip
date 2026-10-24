/**
 * `PreferencesPanel`: the company-preferences form every plugin mounts. It is driven by the field
 * descriptors a plugin's `<plugin>.preferences-load` action returns, so the labels, limits and
 * defaults are written once, on the server. Saving goes through `<plugin>.preferences-save`; the
 * server decides who may change anything and the panel shows its refusal as written.
 */
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Button, Field, Form, Input, PageMessage, Select, TextArea } from "./index.js";
import { usePibBaseStyles } from "./base.js";
import { tokens } from "./tokens.js";
import {
  draftFromValues,
  submitPreferences,
  type PreferenceDescriptor,
  type PreferencesDraft,
  type PreferencesLoadResult,
  type PreferencesSaveResult,
  type PreferenceValue,
  type PreferenceValues,
} from "./preferences-logic.js";

export * from "./preferences-logic.js";

export type PreferencesViewProps = {
  fields: PreferenceDescriptor[];
  draft: PreferencesDraft;
  errors?: Record<string, string>;
  /** The server's refusal or a load/save failure, shown verbatim. */
  failure?: string;
  /** Field ids waiting for the user to confirm. */
  confirming?: string[];
  saved?: { previous: PreferenceValues; changed: string[] } | null;
  busy?: boolean;
  loading?: boolean;
  dirty?: boolean;
  onChange?: (id: string, value: string | boolean) => void;
  onSubmit?: () => void;
  onConfirm?: () => void;
  onCancelConfirm?: () => void;
};

const note: CSSProperties = { margin: 0, fontSize: 12, color: tokens.muted, lineHeight: 1.45, overflowWrap: "anywhere" };
const show = (value: PreferenceValue | undefined) => (value === undefined || value === "" ? "(empty)" : String(value));

export function PreferencesView(props: PreferencesViewProps) {
  const { fields, draft, errors = {}, failure, confirming = [], saved, busy, loading, dirty = true } = props;
  usePibBaseStyles();
  const label = (id: string) => fields.find((f) => f.id === id)?.label ?? id;
  return (
    <div className="pib-ui pib-preferences" style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 12, minWidth: 0, maxWidth: 640 }}>
      <p style={note}>Only owners and admins can change these. Used when sending; no instance admin needed.</p>
      {failure ? <PageMessage message={failure} tone="bad" /> : null}
      {saved ? (
        <PageMessage
          tone="ok"
          message={`Saved. ${saved.changed.map((id) => `${label(id)} was ${show(saved.previous[id])}`).join("; ")}`}
        />
      ) : null}
      {loading ? <p style={note}>Loading…</p> : null}
      {!loading && fields.length === 0 && !failure ? <p style={note}>No preferences to set.</p> : null}
      {fields.length > 0 ? (
        <Form onSubmit={(event) => { event.preventDefault(); props.onSubmit?.(); }}>
          {fields.map((field) => {
            const error = errors[field.id];
            const value = draft[field.id];
            const common = { id: `pref-${field.id}`, "aria-invalid": error ? true : undefined, disabled: busy || confirming.length > 0 } as const;
            const control =
              field.type === "bool" ? (
                <input type="checkbox" {...common} checked={value === true} onChange={(e) => props.onChange?.(field.id, e.target.checked)} style={{ width: 18, height: 18 }} />
              ) : field.type === "text" ? (
                <TextArea {...common} value={String(value ?? "")} maxLength={field.max} onChange={(e) => props.onChange?.(field.id, e.target.value)} />
              ) : field.type === "enum" ? (
                <Select {...common} value={String(value ?? "")} onChange={(e) => props.onChange?.(field.id, e.target.value)}>
                  {(field.options ?? []).map((option) => <option key={option} value={option}>{option}</option>)}
                </Select>
              ) : (
                <Input
                  {...common}
                  type={field.type === "int" ? "number" : "text"}
                  min={field.min}
                  max={field.type === "int" ? field.max : undefined}
                  value={String(value ?? "")}
                  onChange={(e) => props.onChange?.(field.id, e.target.value)}
                />
              );
            return (
              <div key={field.id} style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 4, minWidth: 0 }}>
                <Field label={field.label}>{control}</Field>
                {field.help ? <p style={note}>{field.help}</p> : null}
                {error ? <p role="alert" style={{ ...note, color: tokens.destructive }}>{error}</p> : null}
              </div>
            );
          })}
          {confirming.length > 0 ? (
            <div role="alertdialog" aria-label="Confirm change" style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 8, padding: 12, borderRadius: 10, border: `1px solid ${tokens.tones.warn.border}`, background: tokens.tones.warn.soft, color: tokens.tones.warn.fg, fontSize: 13, overflowWrap: "anywhere" }}>
              <span>Confirm change to {confirming.map(label).join(", ")}? Customers will see the new value.</span>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <Button type="button" onClick={props.onConfirm} disabled={busy}>Confirm and save</Button>
                <Button type="button" variant="secondary" onClick={props.onCancelConfirm} disabled={busy}>Cancel</Button>
              </div>
            </div>
          ) : (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <Button type="submit" disabled={busy || !dirty}>{busy ? "Saving…" : "Save"}</Button>
            </div>
          )}
        </Form>
      ) : null}
    </div>
  );
}

export function PreferencesPanel({ load, save, confirmChange }: {
  /** Calls `<plugin>.preferences-load`. */
  load: () => Promise<PreferencesLoadResult>;
  /** Calls `<plugin>.preferences-save` with the changed fields only. */
  save: (patch: PreferenceValues) => Promise<PreferencesSaveResult>;
  /** Field ids that need a confirm step before saving (e.g. bank details). */
  confirmChange?: readonly string[];
}) {
  const [fields, setFields] = useState<PreferenceDescriptor[]>([]);
  const [values, setValues] = useState<PreferenceValues>({});
  const [draft, setDraft] = useState<PreferencesDraft>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string>();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [confirming, setConfirming] = useState<string[]>([]);
  const [saved, setSaved] = useState<PreferencesViewProps["saved"]>(null);
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    let live = true;
    loadRef.current()
      .then((result) => {
        if (!live) return;
        setFields(result.fields);
        setValues(result.values);
        setDraft(draftFromValues(result.fields, result.values));
      })
      .catch((error) => live && setFailure(error instanceof Error ? error.message : (error as { message?: string } | null)?.message ?? "Could not load preferences"))
      .finally(() => live && setLoading(false));
    return () => { live = false; };
  }, []);

  const run = async (confirmed: boolean) => {
    setBusy(true);
    setFailure(undefined);
    const outcome = await submitPreferences({ fields, values, draft, confirmChange, confirmed, save });
    setBusy(false);
    setErrors(outcome.status === "invalid" ? outcome.errors : {});
    setConfirming(outcome.status === "confirm" ? outcome.fieldIds : []);
    if (outcome.status === "failed") { setFailure(outcome.error); setSaved(null); }
    if (outcome.status === "saved") {
      const changed = fields.filter((f) => outcome.values[f.id] !== outcome.previous[f.id]).map((f) => f.id);
      setValues(outcome.values);
      setDraft(draftFromValues(fields, outcome.values));
      setSaved({ previous: outcome.previous, changed });
    }
  };

  const dirty = JSON.stringify(draft) !== JSON.stringify(draftFromValues(fields, values));
  return (
    <PreferencesView
      fields={fields}
      draft={draft}
      errors={errors}
      failure={failure}
      confirming={confirming}
      saved={saved}
      busy={busy}
      loading={loading}
      dirty={dirty}
      onChange={(id, value) => { setDraft((d) => ({ ...d, [id]: value })); setSaved(null); setErrors((e) => ({ ...e, [id]: "" })); }}
      onSubmit={() => void run(false)}
      onConfirm={() => void run(true)}
      onCancelConfirm={() => setConfirming([])}
    />
  );
}
