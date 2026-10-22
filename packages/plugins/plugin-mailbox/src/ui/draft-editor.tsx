import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { usePluginAction } from "@paperclipai/plugin-sdk/ui";
import { Button, Field, Input, Modal, Pill, TextArea, errorText, formatDateTime, tokens, tone } from "@partnersinbiz/pib-plugin-ui";

type Address = { email: string; name?: string | null };
type FileInfo = { id: string; name: string; mime: string; bytes: number };
type NewFile = { key: string; name: string; mime: string; bytes: number; data: string };

export interface EditableDraft {
  id: string;
  account_id: string;
  subject: string;
  body?: string;
  status: string;
  send_error: string | null;
  to_addrs: Address[] | null;
  cc_addrs?: Address[] | null;
  bcc_addrs?: Address[] | null;
  created_at?: string | null;
  has_html?: boolean;
  use_signature?: boolean;
  files?: FileInfo[];
  rewrite_requested?: { note: string; requested_at: string } | null;
}

interface Props {
  draft: EditableDraft;
  /** The mailbox address the draft goes out from. */
  from: string;
  /** Who wrote it, as a name ("You", an agent's name). */
  drafter: string;
  /** True when an agent wrote it, so "Request rewrite" has someone to ask. */
  agentDrafted: boolean;
  /** Gmail is connected for the mailbox, so it can send (and add a signature or files). */
  canSend: boolean;
  onClose: () => void;
  /** Reload the list and show a message; `close` also closes the editor. */
  onChanged: (message: string, close: boolean) => Promise<void>;
}

const MAX_FILE_BYTES = 7 * 1024 * 1024;
const MAX_FILES = 10;
const EMAIL = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/;

const size = (bytes: number) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);
const same = (a: Address[], b: Address[]) => a.length === b.length && a.every((row, i) => row.email.toLowerCase() === b[i]!.email.toLowerCase());

function readFile(file: File): Promise<NewFile> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`${file.name} could not be read`));
    reader.onload = () => resolve({ key: `${file.name}:${file.size}:${Math.random().toString(36).slice(2)}`, name: file.name, mime: file.type || "application/octet-stream", bytes: file.size, data: String(reader.result).replace(/^data:[^,]*,/, "") });
    reader.readAsDataURL(file);
  });
}

function Note({ children, kind = "warn" }: { children: ReactNode; kind?: "warn" | "ok" }) {
  return <p role="status" style={{ margin: 0, fontSize: 13, lineHeight: 1.45, padding: "8px 12px", borderRadius: 10, border: `1px solid ${tone(kind).border}`, background: tone(kind).soft }}>{children}</p>;
}

/** To / Cc / Bcc: chips for what is added, a box that searches CRM contacts as you type, or takes any address you type. */
function RecipientField({ label, values, onChange, search }: { label: string; values: Address[]; onChange: (next: Address[]) => void; search: (q: string) => Promise<Array<{ id: string; name: string; email: string }>> }) {
  const [text, setText] = useState("");
  const [hits, setHits] = useState<Array<{ id: string; name: string; email: string }>>([]);
  const [open, setOpen] = useState(false);
  const [problem, setProblem] = useState("");
  const ticket = useRef(0);

  useEffect(() => {
    const q = text.trim();
    if (q.length < 2 || q.includes("<")) {
      setHits([]);
      return;
    }
    const mine = ++ticket.current;
    const timer = setTimeout(() => {
      search(q)
        .then((found) => {
          if (mine === ticket.current) setHits(found.filter((hit) => !values.some((v) => v.email.toLowerCase() === hit.email.toLowerCase())));
        })
        .catch(() => {
          if (mine === ticket.current) setHits([]);
        });
    }, 200);
    return () => clearTimeout(timer);
  }, [text]); // eslint-disable-line react-hooks/exhaustive-deps

  function add(row: Address) {
    if (!values.some((v) => v.email.toLowerCase() === row.email.toLowerCase())) onChange([...values, row]);
    setText("");
    setHits([]);
    setProblem("");
  }

  /** Takes what was typed: `a@b.com`, `Name <a@b.com>`, or several split by comma or semicolon. */
  function commit(): boolean {
    const parts = text.split(/[,;]/).map((part) => part.trim()).filter(Boolean);
    if (!parts.length) return true;
    const next = [...values];
    for (const part of parts) {
      const match = part.match(/^(.*)<([^<>]+)>$/);
      const email = (match ? match[2]! : part).trim();
      if (!EMAIL.test(email)) {
        setProblem(`"${part}" is not an email address`);
        return false;
      }
      if (!next.some((v) => v.email.toLowerCase() === email.toLowerCase())) next.push({ email, name: match ? match[1]!.replace(/["']/g, "").trim() || null : null });
    }
    onChange(next);
    setText("");
    setHits([]);
    setProblem("");
    return true;
  }

  function onKey(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter" || event.key === "," || event.key === ";") {
      event.preventDefault();
      if (event.key === "Enter" && hits.length && !text.includes("@")) add({ email: hits[0]!.email, name: hits[0]!.name });
      else commit();
    } else if (event.key === "Backspace" && !text && values.length) onChange(values.slice(0, -1));
  }

  return (
    <Field label={label}>
      <div style={{ position: "relative" }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center", padding: "6px 8px", border: `1px solid ${tokens.border}`, borderRadius: 10, minHeight: 40 }}>
          {values.map((row) => (
            <span key={row.email} style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "2px 8px", borderRadius: 999, background: tone("neutral").soft, border: `1px solid ${tokens.border}`, fontSize: 12.5, maxWidth: "100%", overflowWrap: "anywhere" }}>
              {row.name ? `${row.name} · ${row.email}` : row.email}
              <button type="button" aria-label={`Remove ${row.email}`} onClick={() => onChange(values.filter((v) => v.email !== row.email))} style={{ all: "unset", cursor: "pointer", color: tokens.muted, lineHeight: 1 }}>×</button>
            </span>
          ))}
          <input
            value={text}
            onChange={(event) => {
              setText(event.target.value);
              setOpen(true);
              setProblem("");
            }}
            onKeyDown={onKey}
            onFocus={() => setOpen(true)}
            onBlur={() => setTimeout(() => { setOpen(false); commit(); }, 150)}
            placeholder={values.length ? "" : "Search contacts or type an address"}
            aria-label={label}
            style={{ flex: "1 1 160px", minWidth: 120, border: 0, outline: 0, background: "transparent", color: "inherit", font: "inherit", fontSize: 13.5 }}
          />
        </div>
        {open && hits.length ? (
          <div role="listbox" style={{ position: "absolute", zIndex: 5, left: 0, right: 0, top: "100%", marginTop: 4, background: tokens.card, border: `1px solid ${tokens.border}`, borderRadius: 10, boxShadow: "0 8px 24px rgba(0,0,0,.25)", maxHeight: 220, overflowY: "auto" }}>
            {hits.map((hit) => (
              <button key={`${hit.id}:${hit.email}`} type="button" role="option" aria-selected={false} onMouseDown={(event) => event.preventDefault()} onClick={() => add({ email: hit.email, name: hit.name })} style={{ all: "unset", display: "block", boxSizing: "border-box", width: "100%", padding: "8px 12px", cursor: "pointer", fontSize: 13 }}>
                <strong>{hit.name}</strong> <span style={{ color: tokens.muted }}>{hit.email}</span>
              </button>
            ))}
          </div>
        ) : null}
      </div>
      {problem ? <span style={{ fontSize: 12, color: tone("bad").fg }}>{problem}</span> : null}
    </Field>
  );
}

export function DraftEditor({ draft, from, drafter, agentDrafted, canSend, onClose, onChanged }: Props) {
  const update = usePluginAction("mailbox.update-draft");
  const send = usePluginAction("mailbox.send-draft");
  const remove = usePluginAction("mailbox.delete-draft");
  const rewrite = usePluginAction("mailbox.request-rewrite");
  const contactSearch = usePluginAction("mailbox.contact-search");
  const signature = usePluginAction("mailbox.gmail-signature");

  const startTo = draft.to_addrs ?? [];
  const startCc = draft.cc_addrs ?? [];
  const startBcc = draft.bcc_addrs ?? [];
  const [to, setTo] = useState<Address[]>(startTo);
  const [cc, setCc] = useState<Address[]>(startCc);
  const [bcc, setBcc] = useState<Address[]>(startBcc);
  const [showCc, setShowCc] = useState(startCc.length > 0 || startBcc.length > 0);
  const [subject, setSubject] = useState(draft.subject);
  const [body, setBody] = useState(draft.body ?? "");
  const [useSignature, setUseSignature] = useState(draft.use_signature === true);
  const [signatureText, setSignatureText] = useState<string | null>(null);
  const [signatureNote, setSignatureNote] = useState("");
  const [removed, setRemoved] = useState<string[]>([]);
  const [added, setAdded] = useState<NewFile[]>([]);
  const [panel, setPanel] = useState<"rewrite" | "delete" | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);

  const keptFiles = (draft.files ?? []).filter((file) => !removed.includes(file.id));
  const textChanged = body !== (draft.body ?? "");
  const dirty =
    subject !== draft.subject || textChanged || !same(to, startTo) || !same(cc, startCc) || !same(bcc, startBcc) || useSignature !== (draft.use_signature === true) || removed.length > 0 || added.length > 0;
  const recipients = to.length + cc.length + bcc.length;
  const blocked = !canSend ? `Connect Gmail for ${from} first.` : recipients === 0 ? "Add a recipient first." : !subject.trim() ? "Add a subject first." : null;

  // Show what the signature will look like as soon as the box is ticked.
  useEffect(() => {
    if (!useSignature || signatureText !== null || !canSend) return;
    let live = true;
    (signature({ accountId: draft.account_id }) as Promise<{ html: string; text: string }>)
      .then((result) => {
        if (!live) return;
        setSignatureText(result.text);
        setSignatureNote(result.text ? "" : "Gmail has no signature set for this mailbox, so nothing will be added.");
      })
      .catch((err) => {
        if (live) setSignatureNote(`The Gmail signature could not be read: ${errorText(err)}`);
      });
    return () => {
      live = false;
    };
  }, [useSignature]); // eslint-disable-line react-hooks/exhaustive-deps

  async function pick(files: FileList | null) {
    if (!files?.length) return;
    setError("");
    try {
      const next: NewFile[] = [];
      for (const file of Array.from(files)) {
        if (file.size > MAX_FILE_BYTES) throw new Error(`${file.name} is larger than ${MAX_FILE_BYTES / 1024 / 1024} MB`);
        next.push(await readFile(file));
      }
      if (keptFiles.length + added.length + next.length > MAX_FILES) throw new Error(`A draft can carry at most ${MAX_FILES} files`);
      setAdded((current) => [...current, ...next]);
    } catch (err) {
      setError(errorText(err));
    } finally {
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  const changes = () => ({
    messageId: draft.id,
    subject,
    body,
    to,
    cc,
    bcc,
    useSignature,
    removeFileIds: removed,
  });
  /** The text first, then each new file in its own request: the server takes 10 MB of JSON at a time. */
  async function saveChanges() {
    await update(changes());
    for (const file of added) await update({ messageId: draft.id, addFiles: [{ name: file.name, mime: file.mime, data: file.data }] });
  }

  async function act(work: () => Promise<string>, close = true) {
    setBusy(true);
    setError("");
    try {
      await onChanged(await work(), close);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  const save = () => act(async () => {
    await saveChanges();
    setAdded([]);
    setRemoved([]);
    return "Draft saved";
  }, false);
  const sendNow = () => act(async () => {
    if (dirty) await saveChanges();
    await send({ messageId: draft.id });
    return "Draft sent";
  });
  const askRewrite = () => act(async () => {
    if (dirty) await saveChanges();
    await rewrite({ messageId: draft.id, note: reason });
    return "Asked the agent for a new version";
  });
  const discard = () => act(async () => {
    if (!agentDrafted && !window.confirm("Delete this draft?")) return "Draft kept";
    await remove({ messageId: draft.id, reason });
    return agentDrafted ? "Draft deleted. The agent was told why." : "Draft deleted";
  });

  const reasonOk = reason.trim().length >= 3 || (panel === "delete" && !agentDrafted);

  return (
    <Modal
      open
      title={draft.subject || "(no subject)"}
      description="A draft. Nothing is sent until someone clicks Send."
      onClose={onClose}
      footer={panel ? (
        <>
          <Button type="button" variant="secondary" disabled={busy} onClick={() => { setPanel(null); setReason(""); }}>Back</Button>
          <Button type="button" disabled={busy || !reasonOk} onClick={() => void (panel === "rewrite" ? askRewrite() : discard())}>{panel === "rewrite" ? "Ask for a rewrite" : "Delete draft"}</Button>
        </>
      ) : (
        <>
          <Button type="button" variant="secondary" disabled={busy} onClick={() => (agentDrafted ? setPanel("delete") : void discard())}>{agentDrafted ? "Delete…" : "Delete"}</Button>
          {agentDrafted ? <Button type="button" variant="secondary" disabled={busy} onClick={() => setPanel("rewrite")}>Request rewrite…</Button> : null}
          <Button type="button" variant="secondary" disabled={busy} onClick={onClose}>Close</Button>
          <Button type="button" variant="secondary" disabled={busy || !dirty} onClick={() => void save()}>Save</Button>
          <Button type="button" disabled={busy || Boolean(blocked)} title={blocked ?? undefined} onClick={() => void sendNow()}>Send</Button>
        </>
      )}
    >
      {error ? <Note>{error}</Note> : null}
      {draft.rewrite_requested ? <Note kind="ok">You asked for a new version ({formatDateTime(draft.rewrite_requested.requested_at)}): “{draft.rewrite_requested.note}”. It will replace this text when the agent saves it.</Note> : null}

      {panel ? (
        <>
          <Note kind="ok">
            {panel === "rewrite"
              ? "Tell the agent what to change. It saves a new version over this draft, and keeps any lasting preference for next time."
              : agentDrafted
                ? `This removes the draft. ${drafter} is told your reason and keeps one lesson from it, so say what was wrong.`
                : "This removes the draft."}
          </Note>
          <Field label={panel === "rewrite" ? "What should change?" : "Why delete it?"}>
            <TextArea value={reason} onChange={(event) => setReason(event.target.value)} rows={4} autoFocus placeholder={panel === "rewrite" ? "Shorter, friendlier, and mention the 14 November deadline" : "Wrong tone for this client / sent already by phone / not our job"} />
          </Field>
        </>
      ) : (
        <>
          {blocked && recipients > 0 ? <Note>Can't send yet: {blocked}</Note> : null}
          <Field label="From"><Input value={from} readOnly /></Field>
          <RecipientField label="To" values={to} onChange={setTo} search={async (q) => ((await contactSearch({ q })) as { contacts: Array<{ id: string; name: string; email: string }> }).contacts} />
          {showCc ? (
            <>
              <RecipientField label="Cc" values={cc} onChange={setCc} search={async (q) => ((await contactSearch({ q })) as { contacts: Array<{ id: string; name: string; email: string }> }).contacts} />
              <RecipientField label="Bcc" values={bcc} onChange={setBcc} search={async (q) => ((await contactSearch({ q })) as { contacts: Array<{ id: string; name: string; email: string }> }).contacts} />
            </>
          ) : (
            <div><Button type="button" variant="secondary" onClick={() => setShowCc(true)}>Add Cc / Bcc</Button></div>
          )}
          <Field label="Subject"><Input value={subject} onChange={(event) => setSubject(event.target.value)} /></Field>
          <Field label="Message"><TextArea value={body} onChange={(event) => setBody(event.target.value)} rows={10} /></Field>
          {draft.has_html && textChanged ? <p style={{ margin: 0, fontSize: 12.5, color: tokens.muted }}>Editing the text replaces the designed (HTML) version: what you typed is what is sent.</p> : null}
          {draft.has_html && !textChanged ? <p style={{ margin: 0, fontSize: 12.5, color: tokens.muted }}>This draft also has a designed (HTML) version. The text above is its plain version; editing the text replaces the designed one.</p> : null}

          <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13.5 }}>
            <input type="checkbox" checked={useSignature} disabled={!canSend} onChange={(event) => { setUseSignature(event.target.checked); setSignatureNote(""); }} />
            Use my Gmail signature
          </label>
          {useSignature && signatureText ? <div style={{ fontSize: 12.5, color: tokens.muted, whiteSpace: "pre-wrap", borderLeft: `2px solid ${tokens.border}`, paddingLeft: 10, overflowWrap: "anywhere" }}>{signatureText}</div> : null}
          {useSignature && signatureNote ? <p style={{ margin: 0, fontSize: 12.5, color: tokens.muted }}>{signatureNote}</p> : null}

          <div style={{ display: "grid", gap: 8 }}>
            <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              <Button type="button" variant="secondary" disabled={busy || !canSend} onClick={() => fileInput.current?.click()}>Add files</Button>
              <input ref={fileInput} type="file" multiple hidden onChange={(event) => void pick(event.target.files)} />
              <span style={{ fontSize: 12.5, color: tokens.muted }}>{canSend ? `Up to ${MAX_FILES} files, ${MAX_FILE_BYTES / 1024 / 1024} MB each. Sent with the email.` : "Files need a connected Gmail mailbox."}</span>
            </div>
            {[...keptFiles.map((file) => ({ key: file.id, name: file.name, bytes: file.bytes, remove: () => setRemoved((current) => [...current, file.id]) })), ...added.map((file) => ({ key: file.key, name: file.name, bytes: file.bytes, remove: () => setAdded((current) => current.filter((row) => row.key !== file.key)) }))].map((file) => (
              <div key={file.key} style={{ display: "flex", justifyContent: "space-between", gap: 10, fontSize: 13, padding: "6px 10px", border: `1px solid ${tokens.border}`, borderRadius: 8 }}>
                <span style={{ overflowWrap: "anywhere" }}>{file.name} <span style={{ color: tokens.muted }}>{size(file.bytes)}</span></span>
                <button type="button" onClick={file.remove} aria-label={`Remove ${file.name}`} style={{ all: "unset", cursor: "pointer", color: tokens.muted }}>Remove</button>
              </div>
            ))}
          </div>

          <p style={{ margin: 0, fontSize: 12.5, color: tokens.muted, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            Drafted by {drafter}{draft.created_at ? ` · saved ${formatDateTime(draft.created_at)}` : ""}
            <Pill size="sm" tone="info" dot>Draft</Pill>
          </p>
          {draft.send_error ? <p style={{ margin: 0, fontSize: 12.5, color: tokens.muted }}>Last try: {draft.send_error}</p> : null}
        </>
      )}
    </Modal>
  );
}
