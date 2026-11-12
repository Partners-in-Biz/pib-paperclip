/**
 * Tools a person uses on one post: pick the accounts it goes to, and tell the agent what to change.
 */
import { useEffect, useState } from "react";
import { Button, TextArea, tokens, tone } from "@partnersinbiz/pib-plugin-ui";
import { Card, fmtDate, ignore, Muted, PlatformBadge, platformLabel, Row, SmallButton } from "./parts.js";
import { atHandle } from "./preview-model.js";
import type { Account, Post, RunAction, Snapshot } from "./types.js";

/** A choice kept in this browser (the Posts view, the post's preview switch). Falls back to memory when storage is blocked. */
export function useStoredChoice<T extends string>(key: string, options: readonly T[], initial: T): [T, (value: T) => void] {
  const read = (): T => {
    try {
      const saved = window.localStorage.getItem(key) as T | null;
      return saved && options.includes(saved) ? saved : initial;
    } catch {
      return initial;
    }
  };
  const [value, setValue] = useState<T>(read);
  const set = (next: T) => {
    setValue(next);
    try {
      window.localStorage.setItem(key, next);
    } catch {
      // private window or blocked storage: the choice lasts for this page only
    }
  };
  return [value, set];
}

/** Two or three choices as one control, e.g. Preview | Details. */
export function Switch<T extends string>({ options, value, onChange, label }: { options: Array<{ id: T; label: string }>; value: T; onChange: (value: T) => void; label: string }) {
  const accent = tone("accent");
  return (
    <div role="group" aria-label={label} style={{ display: "inline-flex", border: `1px solid ${tokens.border}`, borderRadius: 9, overflow: "hidden", flexShrink: 0 }}>
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          aria-pressed={value === option.id}
          onClick={() => onChange(option.id)}
          style={{ appearance: "none", border: "none", padding: "0 12px", height: 28, fontSize: 12, fontWeight: 600, fontFamily: "inherit", cursor: "pointer", background: value === option.id ? accent.soft : "transparent", color: value === option.id ? accent.fg : tokens.muted }}
        >{option.label}</button>
      ))}
    </div>
  );
}

/**
 * The scope's accounts as buttons: press one to add it to the post or take it off. `locked` accounts cannot be taken
 * off (already published there, or publishing now).
 */
export function AccountPicker({ accounts, selected, onToggle, onAll, onNone, busyId, locked, lockedHint = "Already posted here" }: {
  accounts: Account[];
  selected: Set<string>;
  onToggle: (account: Account) => void;
  onAll?: () => void;
  onNone?: () => void;
  busyId?: string | null;
  locked?: Set<string>;
  lockedHint?: string;
}) {
  const accent = tone("accent");
  return (
    <div style={{ display: "grid", gap: 6 }}>
      {accounts.length > 1 && (onAll || onNone) ? (
        <Row>
          <Muted>{selected.size} of {accounts.length} selected</Muted>
          {onAll ? <SmallButton onClick={onAll} disabled={selected.size === accounts.length}>All</SmallButton> : null}
          {onNone ? <SmallButton onClick={onNone} disabled={selected.size === 0}>None</SmallButton> : null}
        </Row>
      ) : null}
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {accounts.map((account) => {
          const on = selected.has(account.id);
          const fixed = locked?.has(account.id) ?? false;
          const handle = atHandle(account.handle);
          return (
            <button
              key={account.id}
              type="button"
              aria-pressed={on}
              disabled={fixed || busyId === account.id}
              title={fixed ? lockedHint : on ? "Press to take this account off the post" : "Press to post to this account"}
              onClick={() => onToggle(account)}
              style={{ appearance: "none", display: "flex", gap: 8, alignItems: "center", padding: "6px 10px 6px 6px", borderRadius: 999, border: `1px solid ${on ? accent.border : tokens.border}`, background: on ? accent.soft : "transparent", color: tokens.fg, cursor: fixed ? "default" : "pointer", fontFamily: "inherit", minWidth: 0, maxWidth: "100%", opacity: busyId === account.id ? 0.6 : 1 }}
            >
              {account.avatarUrl
                ? <img src={account.avatarUrl} alt="" width={24} height={24} referrerPolicy="origin" style={{ borderRadius: 999, objectFit: "cover", flexShrink: 0 }} />
                : <PlatformBadge platform={account.platform} size={24} />}
              <span style={{ display: "grid", textAlign: "left", minWidth: 0 }}>
                <span style={{ fontSize: 12, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{account.displayName}</span>
                <span style={{ fontSize: 11, color: tokens.muted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{platformLabel(account.platform)}{handle ? ` · ${handle}` : ""}{account.manual ? " · by hand" : ""}</span>
              </span>
              <span aria-hidden="true" style={{ fontSize: 13, fontWeight: 700, color: on ? accent.fg : tokens.muted, width: 14, textAlign: "center" }}>{on ? "✓" : "+"}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

interface ChangeNote {
  stage: string;
  by: string;
  note: string;
  at: string | null;
}

/** Statuses a person can send back with a note; anything later has published or is publishing. */
export const CAN_ASK_CHANGES = ["draft", "review", "approved", "scheduled"];

/**
 * "Tell the agent what to change": the note goes to the Social agent on the post's task, and the post is a draft
 * until it is fixed and approved again. Earlier change requests on the post show underneath.
 */
export function AskForChanges({ post, snapshot, run }: { post: Post; snapshot: Snapshot; run: RunAction }) {
  const [note, setNote] = useState("");
  const [remember, setRemember] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  const [history, setHistory] = useState<ChangeNote[]>([]);
  const canAsk = CAN_ASK_CHANGES.includes(post.status) && Boolean(snapshot.viewer.userId);

  useEffect(() => {
    let cancelled = false;
    run("social.change-notes", { postId: post.id })
      .then((res) => {
        if (!cancelled) setHistory((res as { notes?: ChangeNote[] } | null)?.notes ?? []);
      })
      .catch(ignore);
    return () => {
      cancelled = true;
    };
  }, [post.id, post.updatedAt, post.status]);

  if (!canAsk && history.length === 0) return null;
  const agent = snapshot.agent.name ?? "the Social agent";
  const moves = post.status === "approved" || post.status === "scheduled";

  const send = () => {
    setBusy(true);
    run("social.request-changes", { postId: post.id, notes: note, remember })
      .then((res) => {
        setSent((res as { changes?: { next?: string } } | null)?.changes?.next ?? "Sent.");
        setNote("");
      })
      .catch(ignore)
      .finally(() => setBusy(false));
  };

  return (
    <Card style={{ gap: 8 }}>
      <strong style={{ fontSize: 12 }}>Ask for changes</strong>
      {canAsk ? (
        <>
          <Muted>
            Say what to change and {agent} fixes the post and sends it for review again.
            {moves ? ` This post is ${post.status}: sending moves it back to draft, so it does not publish until it is approved again.` : post.status === "review" ? " The post goes back to draft." : ""}
          </Muted>
          <TextArea value={note} onChange={(e) => setNote(e.target.value)} rows={3} maxLength={2000} placeholder="For example: lead with the price, drop the last hashtag, use the team photo instead" aria-label="What to change" />
          <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12, color: tokens.fg, cursor: "pointer" }}>
            <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
            Also do this on later posts (the agent adds it to the playbook)
          </label>
          <Row>
            <Button type="button" style={{ height: 30, fontSize: 12 }} disabled={busy || !note.trim()} onClick={send}>{busy ? "Sending…" : "Send to agent"}</Button>
            {sent ? <Muted>{sent}</Muted> : null}
          </Row>
        </>
      ) : null}
      {history.length ? (
        <div style={{ display: "grid", gap: 6 }}>
          {canAsk ? <Muted style={{ fontWeight: 600 }}>Earlier requests</Muted> : null}
          {history.map((item, i) => (
            <div key={`${item.at}-${i}`} style={{ display: "grid", gap: 2, paddingLeft: 10, borderLeft: `2px solid ${tone("warn").border}`, minWidth: 0 }}>
              <Muted>{item.by}{item.at ? ` · ${fmtDate(item.at, snapshot.config.timezone)}` : ""}</Muted>
              <span style={{ fontSize: 12, lineHeight: 1.45, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{item.note}</span>
            </div>
          ))}
        </div>
      ) : null}
    </Card>
  );
}
