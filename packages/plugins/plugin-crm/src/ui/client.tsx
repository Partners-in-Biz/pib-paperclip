/**
 * Client workspace cards: the client profile (how to talk for the client),
 * leads from the client's own channels, a contact's email status, and
 * deleting a company.
 */
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import {
  Button,
  CircleAlert,
  EmptyState,
  Field,
  Form,
  Inbox,
  Input,
  Modal,
  Pill,
  SectionCard,
  Select,
  Sparkles,
  TextArea,
  tokens,
  tone,
} from "@partnersinbiz/pib-plugin-ui";
import { toggleOwned } from "./crm-view.js";
import { FieldList, whenText } from "./parts.js";

export interface ClientProfileView {
  brandVoice: string | null;
  audience: string | null;
  services: string[];
  website: string | null;
  bookingLink: string | null;
  bannedWords: string[];
  toneNotes: string | null;
  humanOwned?: string[];
  updatedAt?: string | null;
}

export interface ClientLeadView {
  key: string;
  source: string;
  platform: string | null;
  name: string | null;
  handle: string | null;
  email: string | null;
  message: string;
  url: string | null;
  capturedAt: string | null;
}

const PROFILE_LABELS: Array<{ key: keyof ClientProfileView; label: string }> = [
  { key: "brandVoice", label: "Brand voice" },
  { key: "audience", label: "Audience" },
  { key: "services", label: "Services they buy" },
  { key: "website", label: "Website" },
  { key: "bookingLink", label: "Booking link" },
  { key: "bannedWords", label: "Banned words" },
  { key: "toneNotes", label: "Tone notes" },
];

const muted = { margin: 0, fontSize: 12.5, color: tokens.muted, lineHeight: 1.45 } as const;

function filled(profile: ClientProfileView | null, key: keyof ClientProfileView): boolean {
  const value = profile?.[key];
  return Array.isArray(value) ? value.length > 0 : Boolean(value);
}

/** The fields still empty, in display order. */
export function missingFields(profile: ClientProfileView | null): string[] {
  return PROFILE_LABELS.filter((row) => !filled(profile, row.key)).map((row) => row.label);
}

function listText(value: string): string[] {
  return [...new Set(value.split(/[,;\n]/).map((part) => part.trim()).filter(Boolean))];
}

function externalLink(url: string) {
  return <a href={url} target="_blank" rel="noreferrer" style={{ color: tokens.primary, fontWeight: 600, overflowWrap: "anywhere" }}>{url.replace(/^https?:\/\//, "")} ↗</a>;
}

/**
 * How to talk for this client. Agents fill it in during onboarding and read
 * it before writing for the client. A field a person fills in is locked
 * (only people change it); each field's lock can be switched.
 */
export function ClientProfileCard({ profile, onSave }: { profile: ClientProfileView | null; onSave: (patch: Record<string, unknown>, success?: string) => Promise<boolean> }) {
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [locking, setLocking] = useState(false);
  const [brandVoice, setBrandVoice] = useState("");
  const [audience, setAudience] = useState("");
  const [services, setServices] = useState("");
  const [website, setWebsite] = useState("");
  const [bookingLink, setBookingLink] = useState("");
  const [bannedWords, setBannedWords] = useState("");
  const [toneNotes, setToneNotes] = useState("");
  const missing = missingFields(profile);

  function startEdit() {
    setBrandVoice(profile?.brandVoice ?? "");
    setAudience(profile?.audience ?? "");
    setServices((profile?.services ?? []).join(", "));
    setWebsite(profile?.website ?? "");
    setBookingLink(profile?.bookingLink ?? "");
    setBannedWords((profile?.bannedWords ?? []).join(", "));
    setToneNotes(profile?.toneNotes ?? "");
    setEditing(true);
  }

  async function toggleLock(keys: string[], lock: boolean, label: string) {
    setLocking(true);
    await onSave({ humanOwned: toggleOwned(profile?.humanOwned ?? [], keys, lock) }, lock ? `${label}: only people can change it now.` : `${label}: agents can update it again.`);
    setLocking(false);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    const ok = await onSave({
      brandVoice,
      audience,
      services: listText(services),
      website,
      bookingLink,
      bannedWords: listText(bannedWords),
      toneNotes,
    });
    setSaving(false);
    if (ok) setEditing(false);
  }

  return (
    <SectionCard
      title="Client profile"
      icon={Sparkles}
      subtitle="How to talk for this client. Agents read it before writing anything for them."
      actions={editing ? undefined : (
        <>
          {missing.length > 0 ? <Pill tone="warn" size="sm" dot>{missing.length} to fill in</Pill> : <Pill tone="ok" size="sm" dot>Complete</Pill>}
          <Button type="button" variant="secondary" style={{ height: 28, fontSize: 12 }} onClick={startEdit}>Edit</Button>
        </>
      )}
    >
      {editing ? (
        <Form onSubmit={(event) => void submit(event)}>
          <Field label="Brand voice">
            <TextArea value={brandVoice} onChange={(event) => setBrandVoice(event.target.value)} placeholder="Warm and plain, like a neighbour who knows plumbing. No jargon." />
          </Field>
          <Field label="Audience">
            <TextArea value={audience} onChange={(event) => setAudience(event.target.value)} placeholder="Homeowners in Durban North who want a fix today." />
          </Field>
          <Field label="Services they buy from us (comma separated)">
            <Input value={services} onChange={(event) => setServices(event.target.value)} placeholder="SEO retainer, social media" />
          </Field>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 200px), 1fr))", gap: 12 }}>
            <Field label="Website">
              <Input value={website} inputMode="url" onChange={(event) => setWebsite(event.target.value)} placeholder="https://acme.co.za" />
            </Field>
            <Field label="Booking link">
              <Input value={bookingLink} inputMode="url" onChange={(event) => setBookingLink(event.target.value)} placeholder="https://acme.co.za/book" />
            </Field>
          </div>
          <Field label="Banned words (comma separated)">
            <Input value={bannedWords} onChange={(event) => setBannedWords(event.target.value)} placeholder="cheap, guaranteed" />
          </Field>
          <Field label="Tone notes">
            <TextArea value={toneNotes} onChange={(event) => setToneNotes(event.target.value)} placeholder="No emoji. Say 'you', never 'customers'." />
          </Field>
          <p style={muted}>What you fill in here is locked: agents keep it as it is and only fill fields that are empty.</p>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", flexWrap: "wrap" }}>
            <Button type="button" variant="secondary" onClick={() => setEditing(false)} disabled={saving}>Cancel</Button>
            <Button type="submit" disabled={saving}>{saving ? "Saving…" : "Save profile"}</Button>
          </div>
        </Form>
      ) : missing.length === PROFILE_LABELS.length ? (
        <EmptyState
          compact
          icon={Sparkles}
          title="No profile yet"
          description="The Account Manager fills this in during onboarding. Add what you know now so every post, email and report sounds like them."
          action={<Button type="button" onClick={startEdit}>Fill in the profile</Button>}
        />
      ) : (
        <FieldList
          rows={PROFILE_LABELS.map((row) => {
            const value = profile?.[row.key];
            let shown: ReactNode = <span style={{ color: tokens.muted }}>Not set</span>;
            if (Array.isArray(value) && value.length) shown = value.join(", ");
            else if (typeof value === "string" && value) shown = row.key === "website" || row.key === "bookingLink" ? externalLink(value) : <span style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{value}</span>;
            return { key: row.key, label: row.label, value: shown };
          })}
          owned={profile?.humanOwned ?? []}
          busy={locking}
          onToggle={(keys, lock, label) => void toggleLock(keys, lock, label)}
        />
      )}
    </SectionCard>
  );
}

const SOURCE_LABEL: Record<string, string> = { social: "Social", email: "Email", form: "Form", other: "Other" };

/** Leads that came in on the client's own channels: theirs, never our contacts. */
export function ClientLeadsCard({ leads }: { leads: ClientLeadView[] }) {
  return (
    <SectionCard
      title={`Leads from their channels (${leads.length})`}
      icon={Inbox}
      subtitle="People who contacted this client's own social accounts or mailbox. They are the client's leads: kept here, never added to our contacts or campaigns (POPIA, South Africa's privacy law)."
    >
      {leads.length === 0 ? (
        <p style={muted}>None yet. When someone asks about buying in a DM or comment on this client's connected accounts, it shows here and the client's Social inbox answers it.</p>
      ) : (
        <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "grid", gap: 10 }}>
          {leads.map((lead) => (
            <li key={lead.key} style={{ display: "grid", gap: 4, padding: 10, borderRadius: 10, border: `1px solid ${tokens.border}`, minWidth: 0 }}>
              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", minWidth: 0 }}>
                <Pill size="sm" tone="info">{lead.platform ? lead.platform.charAt(0).toUpperCase() + lead.platform.slice(1) : SOURCE_LABEL[lead.source] ?? lead.source}</Pill>
                <strong style={{ fontSize: 13, overflowWrap: "anywhere" }}>{lead.name ?? (lead.handle ? `@${lead.handle}` : lead.email ?? "Someone")}</strong>
                {lead.handle && lead.name ? <span style={{ fontSize: 12, color: tokens.muted }}>@{lead.handle}</span> : null}
                <span style={{ fontSize: 12, color: tokens.muted, marginLeft: "auto" }}>{whenText(lead.capturedAt) ?? ""}</span>
              </div>
              {lead.message ? <p style={{ margin: 0, fontSize: 13, lineHeight: 1.45, overflowWrap: "anywhere" }}>{lead.message}</p> : null}
              {lead.url ? <span style={{ fontSize: 12 }}>{externalLink(lead.url)}</span> : null}
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}

export type EmailStatus = "ok" | "unsubscribed" | "bounced";

const STATUS_TEXT: Record<EmailStatus, string> = {
  ok: "Can get email",
  unsubscribed: "Unsubscribed",
  bounced: "Email bounced",
};

/** A person records an opt-out or a bounce (or allows email again). */
export function EmailStatusControl({ status, onSave }: { status: EmailStatus; onSave: (status: EmailStatus, note: string) => Promise<boolean> }) {
  const [next, setNext] = useState<EmailStatus>(status);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const changed = next !== status;
  return (
    <div style={{ display: "grid", gap: 8 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <span style={{ fontSize: 12.5, fontWeight: 600 }}>Marketing email</span>
        <Pill tone={status === "ok" ? "ok" : status === "bounced" ? "bad" : "warn"} size="sm" dot>{STATUS_TEXT[status]}</Pill>
      </div>
      <Form onSubmit={(event) => {
        event.preventDefault();
        setSaving(true);
        void onSave(next, note).then((ok) => {
          setSaving(false);
          if (ok) setNote("");
        });
      }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 160px), 1fr))", gap: 8 }}>
          <Select aria-label="Email status" value={next} onChange={(event) => setNext(event.target.value as EmailStatus)}>
            <option value="ok">Can get email</option>
            <option value="unsubscribed">Unsubscribed (asked to stop)</option>
            <option value="bounced">Bounced (address does not work)</option>
          </Select>
          <Input aria-label="Why" value={note} onChange={(event) => setNote(event.target.value)} placeholder="Why, e.g. asked on a call" />
        </div>
        {changed ? (
          <p style={muted}>
            {next === "ok"
              ? "Only allow email again when they asked for it. Campaigns and the Mailbox keep their own opt-out lists."
              : "Stops their sequences and tells Campaigns and the Mailbox not to send them marketing email."}
          </p>
        ) : null}
        <div>
          <Button type="submit" variant="secondary" disabled={!changed || saving}>{saving ? "Saving…" : "Save email status"}</Button>
        </div>
      </Form>
    </div>
  );
}

/**
 * Deleting a company (from the page's ⋯ menu): its people stay as contacts
 * and its deals stay, unlinked. The person types the name to confirm.
 */
export function DeleteCompanyDialog({ open, name, onClose, onDelete }: { open: boolean; name: string; onClose: () => void; onDelete: () => Promise<boolean> }) {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) setTyped("");
  }, [open]);
  const bad = tone("bad");
  return (
    <Modal
      open={open}
      title={`Delete ${name}?`}
      description="Its people stay as contacts and its deals stay, without a company. Its notes, profile and client leads are removed, and every module drops it from its client list. To stop working for a client, set its lifecycle to churned instead."
      onClose={() => {
        if (!busy) onClose();
      }}
      footer={(
        <>
          <Button type="button" variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button
            type="button"
            disabled={typed.trim() !== name || busy}
            style={{ background: bad.solid, color: "white" }}
            onClick={() => {
              setBusy(true);
              void onDelete().then((ok) => {
                setBusy(false);
                if (ok) onClose();
              });
            }}
          >
            {busy ? "Deleting…" : "Delete company"}
          </Button>
        </>
      )}
    >
      <p style={{ ...muted, display: "flex", gap: 6, alignItems: "flex-start" }}>
        <CircleAlert size={14} style={{ flexShrink: 0, marginTop: 2 }} aria-hidden="true" />
        This cannot be undone.
      </p>
      <Field label={`Type ${name} to confirm`}>
        <Input value={typed} onChange={(event) => setTyped(event.target.value)} placeholder={name} autoComplete="off" />
      </Field>
    </Modal>
  );
}
