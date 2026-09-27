/**
 * The deal drawer, the same on the Deals tab and on a client's page: what the
 * deal is worth, where it stands and who it is for; edit it, link its client,
 * move it, log a note, and draft its quote in Billing.
 */
import { useEffect, useState, type FormEvent } from "react";
import { useHostNavigation, usePluginAction } from "@paperclipai/plugin-sdk/ui";
import {
  Button,
  Field,
  Form,
  Input,
  Pill,
  Select,
  Sheet,
  TextArea,
  errorText,
  formatMoney,
  tokens,
  tone,
  useIsNarrow,
} from "@partnersinbiz/pib-plugin-ui";
import { withClientParam } from "@partnersinbiz/pib-plugin-kit/client-ref";
import { moneyInputValue, parseMoneyInput, quoteHref } from "./crm-view.js";
import { ActivityTimeline, StagePill, type ActivityLike } from "./overview.js";

export interface DealView {
  id: string;
  title: string;
  amountMinor: number;
  currency: string;
  stageId: string;
  accountId: string | null;
  contactId: string | null;
}

export interface NamedOption {
  id: string;
  name: string;
}

export interface StageOption {
  id: string;
  name: string;
  kind: string;
  position: number;
}

const byName = (a: NamedOption, b: NamedOption) => a.name.localeCompare(b.name);

export function DealSheet({ deal, stages, companies, contacts, billing, onClose, onChanged }: {
  /** The open deal; null closes the drawer. */
  deal: DealView | null;
  stages: StageOption[];
  companies: NamedOption[];
  contacts: NamedOption[];
  /** Billing's quote form: null hides "Draft a quote" (Billing is not installed). `prefill` when Billing reads new=1 and dealId. */
  billing: { prefill: boolean } | null;
  onClose: () => void;
  /** Reload the page's data after a change (the drawer stays open on the fresh deal). */
  onChanged: () => Promise<void>;
}) {
  const navigation = useHostNavigation();
  const narrow = useIsNarrow();
  const updateDeal = usePluginAction("crm.update-deal");
  const logActivity = usePluginAction("crm.log-activity");
  const loadActivities = usePluginAction("crm.activities");

  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ text: string; bad?: boolean } | null>(null);
  const [timeline, setTimeline] = useState<ActivityLike[] | null>(null);
  const [note, setNote] = useState("");
  const [title, setTitle] = useState("");
  const [value, setValue] = useState("");
  const [currency, setCurrency] = useState("ZAR");
  const [companyId, setCompanyId] = useState("");
  const [contactId, setContactId] = useState("");

  const dealId = deal?.id ?? null;

  async function refreshTimeline(id: string) {
    try {
      setTimeline(((await loadActivities({ recordType: "deal", recordId: id })) as ActivityLike[]) ?? []);
    } catch {
      setTimeline([]);
    }
  }

  useEffect(() => {
    setEditing(false);
    setNotice(null);
    setNote("");
    setTimeline(null);
    if (dealId) void refreshTimeline(dealId);
  }, [dealId]);

  if (!deal) return null;
  const current = deal;
  const stage = stages.find((row) => row.id === current.stageId) ?? null;
  const companyName = current.accountId ? companies.find((row) => row.id === current.accountId)?.name ?? "A company" : null;
  const contactName = current.contactId ? contacts.find((row) => row.id === current.contactId)?.name ?? "A contact" : null;
  const hasClient = Boolean(current.accountId || current.contactId);
  const quote = billing ? quoteHref(current, billing.prefill) : null;
  const orderedStages = [...stages].sort((a, b) => a.position - b.position);

  function startEdit() {
    setTitle(current.title);
    setValue(moneyInputValue(current.amountMinor));
    setCurrency(current.currency);
    setCompanyId(current.accountId ?? "");
    setContactId(current.contactId ?? "");
    setNotice(null);
    setEditing(true);
  }

  async function save(params: Record<string, unknown>, done: string): Promise<boolean> {
    setBusy(true);
    setNotice(null);
    type Saved = { won?: { emitted?: boolean } | null } | null;
    let result: Saved = null;
    try {
      result = (await updateDeal({ dealId: current.id, ...params })) as Saved;
    } catch (error) {
      setNotice({ text: errorText(error), bad: true });
      setBusy(false);
      return false;
    }
    // Saved: reload the page and this deal's timeline (a failed reload does not undo the save).
    await onChanged().catch(() => undefined);
    await refreshTimeline(current.id);
    setNotice({ text: result?.won?.emitted ? `${done} Billing and the Cockpit were told it is won.` : done });
    setBusy(false);
    return true;
  }

  async function submitEdit(event: FormEvent) {
    event.preventDefault();
    const amountMinor = parseMoneyInput(value);
    if (amountMinor === null) {
      setNotice({ text: "Type the value in rand, e.g. 15000 or 15 000.50.", bad: true });
      return;
    }
    // Only what changed is sent (each change is kept in the deal's field history); an empty choice unlinks.
    const params: Record<string, unknown> = {};
    const code = currency.trim().toUpperCase() || "ZAR";
    if (title.trim() !== current.title) params.title = title.trim();
    if (amountMinor !== current.amountMinor) params.amountMinor = amountMinor;
    if (code !== current.currency) params.currency = code;
    if ((current.accountId ?? "") !== companyId) params.companyRecordId = companyId;
    if ((current.contactId ?? "") !== contactId) params.contactId = contactId;
    if (Object.keys(params).length === 0) {
      setEditing(false);
      return;
    }
    const ok = await save(params, "Deal saved.");
    if (ok) setEditing(false);
  }

  async function submitNote(event: FormEvent) {
    event.preventDefault();
    if (!note.trim()) return;
    setBusy(true);
    setNotice(null);
    try {
      await logActivity({ recordType: "deal", recordId: current.id, kind: "note", body: note.trim() });
      setNote("");
      await refreshTimeline(current.id);
      setNotice({ text: "Note logged." });
    } catch (error) {
      setNotice({ text: errorText(error), bad: true });
    } finally {
      setBusy(false);
    }
  }

  const link = (kind: "company" | "contact", id: string, name: string) => (
    <a {...navigation.linkProps(withClientParam("/crm", { kind, id }))} style={{ color: tokens.primary, fontWeight: 600, textDecoration: "none", overflowWrap: "anywhere" }}>{name}</a>
  );

  return (
    <Sheet open title={current.title} onClose={onClose}>
      {notice ? (
        <p role="status" style={{ margin: 0, fontSize: 13, padding: "8px 12px", borderRadius: 10, border: `1px solid ${notice.bad ? tone("bad").border : tokens.border}`, background: notice.bad ? tone("bad").soft : tokens.secondary, color: notice.bad ? tone("bad").fg : tokens.fg, overflowWrap: "anywhere" }}>
          {notice.text}
        </p>
      ) : null}

      {editing ? (
        <Form onSubmit={(event) => void submitEdit(event)}>
          <Field label="Title">
            <Input value={title} onChange={(event) => setTitle(event.target.value)} required />
          </Field>
          <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 2fr) minmax(0, 1fr)", gap: 12 }}>
            <Field label="Value">
              <Input value={value} inputMode="decimal" onChange={(event) => setValue(event.target.value)} placeholder="15000" />
            </Field>
            <Field label="Currency">
              <Input value={currency} maxLength={3} onChange={(event) => setCurrency(event.target.value.toUpperCase())} placeholder="ZAR" />
            </Field>
          </div>
          <Field label="Company">
            <Select value={companyId} onChange={(event) => setCompanyId(event.target.value)}>
              <option value="">No company</option>
              {[...companies].sort(byName).map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}
            </Select>
          </Field>
          <Field label="Contact">
            <Select value={contactId} onChange={(event) => setContactId(event.target.value)}>
              <option value="">No contact</option>
              {[...contacts].sort(byName).map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}
            </Select>
          </Field>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", flexWrap: "wrap" }}>
            <Button type="button" variant="secondary" disabled={busy} onClick={() => setEditing(false)}>Cancel</Button>
            <Button type="submit" disabled={busy || !title.trim()}>{busy ? "Saving…" : "Save deal"}</Button>
          </div>
        </Form>
      ) : (
        <>
          <div style={{ display: "grid", gap: 6 }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
              {current.amountMinor > 0
                ? <strong style={{ fontSize: 24, fontWeight: 650, letterSpacing: "-0.02em", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>{formatMoney(current.amountMinor, current.currency)}</strong>
                : <Pill tone="warn" dot>No value yet</Pill>}
              {stage ? <StagePill name={stage.name} kind={stage.kind} size="sm" /> : null}
            </div>
            <div style={{ fontSize: 13, color: tokens.muted, lineHeight: 1.5 }}>
              {hasClient ? (
                <>For {companyName && current.accountId ? link("company", current.accountId, companyName) : null}{companyName && contactName ? " · " : null}{contactName && current.contactId ? link("contact", current.contactId, contactName) : null}</>
              ) : (
                <span style={{ color: tone("warn").fg }}>Not linked to a client yet. Link its company or contact so it can be quoted.</span>
              )}
            </div>
          </div>

          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            {quote && stage?.kind === "open" ? (
              <a {...navigation.linkProps(quote)} style={{ display: "inline-flex", alignItems: "center", height: narrow ? 40 : 36, padding: "0 14px", borderRadius: 9, background: tokens.primary, color: tokens.primaryFg, fontSize: 13, fontWeight: 600, textDecoration: "none", whiteSpace: "nowrap" }}>
                Draft a quote →
              </a>
            ) : null}
            <Button type="button" variant={quote && stage?.kind === "open" ? "secondary" : "primary"} onClick={startEdit} disabled={busy}>
              {hasClient ? "Edit deal" : "Edit and link a client"}
            </Button>
          </div>
          {billing && !hasClient && stage?.kind === "open" ? (
            <p style={{ margin: 0, fontSize: 12, color: tokens.muted }}>Draft a quote once the deal has its client.</p>
          ) : null}

          <Field label="Stage">
            <Select
              aria-label="Stage"
              value={current.stageId}
              disabled={busy}
              onChange={(event) => void save({ stageId: event.target.value }, "Deal moved.")}
            >
              {orderedStages.map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}
            </Select>
          </Field>
          <p style={{ margin: "-8px 0 0", fontSize: 12, color: tokens.muted, lineHeight: 1.45 }}>
            Won makes the client a customer and tells Billing. Won or lost stops the contact's sequences.
          </p>

          <Form onSubmit={(event) => void submitNote(event)}>
            <Field label="Log a note">
              <TextArea value={note} onChange={(event) => setNote(event.target.value)} placeholder="What was said or decided, or the next step…" />
            </Field>
            <div>
              <Button type="submit" variant="secondary" disabled={busy || !note.trim()}>Log note</Button>
            </div>
          </Form>

          <div style={{ display: "grid", gap: 8 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: tokens.muted }}>Activity</div>
            {timeline === null ? <p style={{ margin: 0, fontSize: 13, color: tokens.muted }}>Loading…</p> : <ActivityTimeline items={timeline} limit={20} />}
          </div>
        </>
      )}
    </Sheet>
  );
}
