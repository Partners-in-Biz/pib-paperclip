/**
 * Cockpit → Profile: the company profile every agent reads before it writes
 * in the company's name (`company-profile`). People edit any field here;
 * agents may only fill empty ones, and those are marked so the owner can
 * check them.
 */
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { usePluginAction } from "@paperclipai/plugin-sdk/ui";
import { Building2, Button, EmptyState, Field, Input, PageMessage, Pill, Sparkles, TextArea, TriangleAlert, errorText, formatShortDate, formatDate, tokens, tone, useIsNarrow } from "@partnersinbiz/pib-plugin-ui";
import {
  cleanField,
  CORE_PROFILE_FIELDS,
  fieldLabels,
  missingFields,
  PROFILE_FIELDS,
  PROFILE_GROUPS,
  type CompanyProfile,
  type FilledBy,
  type ProfileField,
  type ProfileFieldKey,
} from "../profile-model.js";
import { Card, Muted, type LinkPropsFor } from "./components.js";

export interface StoredProfileView {
  profile: CompanyProfile;
  filledBy: FilledBy;
  updatedAt: string | null;
}

export type ProfileDraft = Record<ProfileFieldKey, string>;

/** The form's text for each field (banned words one per line). */
export function draftFrom(profile: CompanyProfile): ProfileDraft {
  const out = {} as ProfileDraft;
  for (const field of PROFILE_FIELDS) {
    const value = profile[field.key];
    out[field.key] = Array.isArray(value) ? value.join("\n") : typeof value === "string" ? value : "";
  }
  return out;
}

/** Field errors for the draft (empty when it can be saved). */
export function draftErrors(draft: ProfileDraft): Partial<Record<ProfileFieldKey, string>> {
  const out: Partial<Record<ProfileFieldKey, string>> = {};
  for (const field of PROFILE_FIELDS) {
    try {
      cleanField(field.key, draft[field.key]);
    } catch (error) {
      out[field.key] = error instanceof Error ? error.message : String(error);
    }
  }
  return out;
}

function sameDraft(a: ProfileDraft, b: ProfileDraft): boolean {
  return PROFILE_FIELDS.every((field) => (a[field.key] ?? "").trim() === (b[field.key] ?? "").trim());
}

/** "Filled in by an agent on 27 Sep: check it" for fields an agent filled. */
export function agentNote(entry: FilledBy[ProfileFieldKey] | undefined, now: Date = new Date()): string | null {
  if (!entry || entry.by !== "agent") return null;
  const day = entry.at ? formatShortDate(entry.at, now) : null;
  return `Filled in by an agent${day && day !== "–" ? ` on ${day}` : ""}: check it.`;
}

function FieldInput({ field, value, error, note, onChange }: { field: ProfileField; value: string; error?: string; note: string | null; onChange: (value: string) => void }) {
  const wide = field.kind === "long" || field.kind === "list";
  const id = `profile-${field.key}`;
  return (
    <div style={{ display: "grid", gap: 6, minWidth: 0, gridColumn: wide ? "1 / -1" : undefined }}>
      <Field label={field.label}>
        {wide ? (
          <TextArea
            id={id}
            value={value}
            rows={field.kind === "list" ? 3 : 4}
            placeholder={field.kind === "list" ? "cheap\nguaranteed results\nworld-class" : field.placeholder}
            aria-invalid={error ? true : undefined}
            onChange={(event) => onChange(event.target.value)}
          />
        ) : (
          <Input
            id={id}
            value={value}
            type={field.kind === "email" ? "email" : field.kind === "url" ? "url" : "text"}
            inputMode={field.kind === "vat" ? "numeric" : field.kind === "email" ? "email" : field.kind === "url" ? "url" : undefined}
            placeholder={field.placeholder}
            aria-invalid={error ? true : undefined}
            onChange={(event) => onChange(event.target.value)}
          />
        )}
      </Field>
      {error ? (
        <span role="alert" style={{ fontSize: 12, color: tone("bad").fg, lineHeight: 1.4 }}>{error}</span>
      ) : (
        <span style={{ fontSize: 12, color: tokens.muted, lineHeight: 1.4 }}>{field.hint}</span>
      )}
      {note ? (
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, color: tone("info").fg, lineHeight: 1.4 }}>
          <Sparkles size={13} aria-hidden="true" style={{ flexShrink: 0 }} />
          {note}
        </span>
      ) : null}
    </div>
  );
}

/** Where Billing and Accounting keep their own copy of the legal details (their settings pages). */
export interface LegalCopies {
  linkFor?: LinkPropsFor;
  billingSettingsHref?: string | null;
  accountingSettingsHref?: string | null;
}

/**
 * One line: Billing and Accounting hold their own legal name and VAT number
 * (the Cockpit cannot read them), so the owner keeps them the same.
 */
export function LegalCopiesNote({ linkFor, billingSettingsHref, accountingSettingsHref }: LegalCopies) {
  const link = (href: string | null | undefined, label: string) => (href && linkFor
    ? <a {...linkFor(href)} style={{ color: tokens.primary, fontWeight: 600, textDecoration: "none" }}>{label}</a>
    : <strong style={{ fontWeight: 600 }}>{label}</strong>);
  return (
    <p style={{ margin: 0, fontSize: 12.5, color: tokens.muted, lineHeight: 1.5 }}>
      Billing and Accounting keep their own legal name and VAT number: keep them the same as here in {link(billingSettingsHref, "Billing → Settings")} and {link(accountingSettingsHref, "Accounting → Settings")}.
    </p>
  );
}

/** The form (presentational, so tests render it). */
export function ProfileForm({ stored, draft, busy, message, onChange, onSave, onReset, legal }: {
  stored: StoredProfileView;
  draft: ProfileDraft;
  busy: boolean;
  message: { text: string; tone: "ok" | "bad" } | null;
  onChange: (key: ProfileFieldKey, value: string) => void;
  onSave: () => void;
  onReset: () => void;
  legal?: LegalCopies;
}) {
  const narrow = useIsNarrow();
  const errors = draftErrors(draft);
  const dirty = !sameDraft(draft, draftFrom(stored.profile));
  const missing = missingFields(stored.profile);
  const coreMissing = CORE_PROFILE_FIELDS.filter((key) => missing.includes(key));
  const agentFilled = PROFILE_FIELDS.filter((field) => stored.filledBy[field.key]?.by === "agent").length;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!busy && dirty && Object.keys(errors).length === 0) onSave();
  };
  return (
    <form onSubmit={submit} style={{ display: "grid", gap: 16, minWidth: 0 }}>
      <Card
        title="Company profile"
        icon={Building2}
        tone={coreMissing.length ? "warn" : "ok"}
        strip={coreMissing.length > 0}
        subtitle="Agents read this before they write anything in the company's name: posts, emails, invoices, quotes and replies."
        actions={<Pill tone={missing.length ? "warn" : "ok"} dot>{PROFILE_FIELDS.length - missing.length} of {PROFILE_FIELDS.length} set</Pill>}
      >
        {coreMissing.length ? (
          <div role="status" style={{ display: "flex", gap: 10, alignItems: "flex-start", padding: "10px 12px", borderRadius: 12, background: tone("warn").soft, border: `1px solid ${tone("warn").border}`, fontSize: 13, lineHeight: 1.5 }}>
            <TriangleAlert size={16} color={tone("warn").solid} aria-hidden="true" style={{ flexShrink: 0, marginTop: 2 }} />
            <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>Agents still need the {fieldLabels(coreMissing)}. The Operator can draft empty fields from the website; you check them here.</span>
          </div>
        ) : null}
        <Muted>Agents may only fill empty fields{agentFilled ? ` (they filled ${agentFilled}; those are marked)` : ""}. Changing a value is up to you: they ask with a question in Waiting on you.</Muted>
        <LegalCopiesNote {...(legal ?? {})} />
      </Card>

      {PROFILE_GROUPS.map((group) => (
        <Card key={group.key} title={group.title} subtitle={group.description}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(min(260px, 100%), 1fr))", gap: 14, minWidth: 0 }}>
            {PROFILE_FIELDS.filter((field) => field.group === group.key).map((field) => (
              <FieldInput
                key={field.key}
                field={field}
                value={draft[field.key] ?? ""}
                error={errors[field.key]}
                note={agentNote(stored.filledBy[field.key])}
                onChange={(value) => onChange(field.key, value)}
              />
            ))}
          </div>
        </Card>
      ))}

      {/* Save stays in reach while scrolling; on a phone it sits above the host's bottom tab bar (64px). */}
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", position: "sticky", bottom: narrow ? "calc(64px + env(safe-area-inset-bottom, 0px))" : 0, padding: "10px 0", background: tokens.bg, borderTop: `1px solid ${tokens.border}`, zIndex: 1 }}>
        <Button type="submit" disabled={busy || !dirty || Object.keys(errors).length > 0}>{busy ? "Saving…" : "Save profile"}</Button>
        <Button type="button" variant="secondary" disabled={busy || !dirty} onClick={onReset}>Undo changes</Button>
        {message ? (
          <span role="status" style={{ fontSize: 13, color: tone(message.tone).fg, minWidth: 0, overflowWrap: "anywhere" }}>{message.text}</span>
        ) : dirty ? (
          <span style={{ fontSize: 13, color: tokens.muted }}>Unsaved changes.</span>
        ) : stored.updatedAt ? (
          <span style={{ fontSize: 13, color: tokens.muted }}>Saved {formatDate(stored.updatedAt)}.</span>
        ) : null}
      </div>
    </form>
  );
}

/** The Profile tab: loads, edits and saves the profile. */
export function ProfilePanel({ refreshKey = 0, ...legal }: { refreshKey?: number } & LegalCopies) {
  const load = usePluginAction("profile.load");
  const save = usePluginAction("profile.save");
  const [stored, setStored] = useState<StoredProfileView | null>(null);
  const [draft, setDraft] = useState<ProfileDraft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; tone: "ok" | "bad" } | null>(null);

  const reload = useCallback(async () => {
    setError(null);
    try {
      const data = (await load({})) as StoredProfileView;
      const next = { profile: data?.profile ?? {}, filledBy: data?.filledBy ?? {}, updatedAt: data?.updatedAt ?? null };
      setStored(next);
      setDraft(draftFrom(next.profile));
    } catch (err) {
      setError(errorText(err));
    }
  }, [load]);

  useEffect(() => {
    void reload();
  }, [reload, refreshKey]);

  const onChange = useMemo(() => (key: ProfileFieldKey, value: string) => {
    setMessage(null);
    setDraft((current) => (current ? { ...current, [key]: value } : current));
  }, []);

  if (error && !stored) {
    return <EmptyState tone="bad" icon={TriangleAlert} title="The profile could not load" description={error} action={<Button type="button" variant="secondary" onClick={() => void reload()}>Try again</Button>} />;
  }
  if (!stored || !draft) return <Muted>Loading the company profile…</Muted>;

  async function doSave() {
    if (!draft) return;
    setBusy(true);
    setMessage(null);
    try {
      const data = (await save({ profile: draft })) as StoredProfileView & { changed?: string[] };
      const next = { profile: data?.profile ?? {}, filledBy: data?.filledBy ?? {}, updatedAt: data?.updatedAt ?? null };
      setStored(next);
      setDraft(draftFrom(next.profile));
      const count = data?.changed?.length ?? 0;
      setMessage({ tone: "ok", text: count ? `Saved ${count} ${count === 1 ? "change" : "changes"}. Agents use it from their next task.` : "Nothing changed." });
    } catch (err) {
      setMessage({ tone: "bad", text: errorText(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: "grid", gap: 12, minWidth: 0 }}>
      {error ? <PageMessage message={error} tone="bad" /> : null}
      <ProfileForm
        stored={stored}
        draft={draft}
        busy={busy}
        message={message}
        onChange={onChange}
        legal={legal}
        onSave={() => void doSave()}
        onReset={() => {
          setMessage(null);
          setDraft(draftFrom(stored.profile));
        }}
      />
    </div>
  );
}
