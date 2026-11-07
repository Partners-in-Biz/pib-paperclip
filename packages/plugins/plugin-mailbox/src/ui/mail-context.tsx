import { useEffect, useState } from "react";
import { useHostNavigation, usePluginAction } from "@paperclipai/plugin-sdk/ui";
import { Pill, errorText, formatDateTime, tokens } from "@partnersinbiz/pib-plugin-ui";
import { taskHref, taskLinkLine, taskLinkName, taskStatusName, taskTone } from "./view.js";

type Address = { email: string; name?: string | null };

export interface TaskLink {
  primary: { id: string; identifier: string | null; title: string; status: string };
  total: number;
  open: number;
}
interface ThreadMessage {
  id: string;
  direction: string;
  subject: string;
  from: Address | null;
  to: Address[];
  at: string | null;
  snippet: string | null;
  private: boolean;
  files: number;
  current: boolean;
  replyingTo: boolean;
}
interface LinkedTask {
  id: string;
  identifier: string | null;
  title: string;
  status: string;
  assignee: string | null;
  link: string;
  depth: number;
}
interface ThreadContext {
  messages: ThreadMessage[];
  moreMessages: number;
  tasks: LinkedTask[];
  moreTasks: number;
}
type Body = { text: string | null; note: string | null; truncated: boolean };

const heading = { margin: 0, fontSize: 12, fontWeight: 600, letterSpacing: "0.04em", textTransform: "uppercase", color: tokens.muted } as const;
const muted = { margin: 0, fontSize: 12.5, color: tokens.muted, lineHeight: 1.45 } as const;
const who = (a: Address | null | undefined) => (a ? a.name || a.email : "Unknown sender");

/** The small link a list row shows: its first task and how many more there are. */
export function TaskChip({ link }: { link: TaskLink }) {
  const navigation = useHostNavigation();
  const title = `${link.primary.title}${link.total > 1 ? ` (and ${link.total - 1} more, ${link.open} still open)` : ""}`;
  return (
    <a {...navigation.linkProps(taskHref(link.primary))} title={title} style={{ textDecoration: "none", display: "inline-flex", maxWidth: "100%" }}>
      <Pill size="sm" tone={taskTone(link.primary.status)} dot>{taskLinkLine(link)}</Pill>
    </a>
  );
}

function ThreadRow({ message, startOpen }: { message: ThreadMessage; startOpen: boolean }) {
  const getMessage = usePluginAction("mailbox.get-message");
  const [open, setOpen] = useState(startOpen);
  const [body, setBody] = useState<Body | null>(null);

  useEffect(() => {
    if (!open || body) return;
    let live = true;
    (getMessage({ messageId: message.id, maxChars: 20000 }) as Promise<{ text?: string; note?: string; truncated?: boolean }>)
      .then((out) => {
        if (live) setBody({ text: out.text ?? "", note: out.note ?? null, truncated: Boolean(out.truncated) });
      })
      .catch((error: unknown) => {
        if (live) setBody({ text: null, note: `This message could not be read: ${errorText(error)}`, truncated: false });
      });
    return () => {
      live = false;
    };
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const outbound = message.direction === "outbound";
  return (
    <div style={{ border: `1px solid ${tokens.border}`, borderRadius: 10, minWidth: 0, overflow: "hidden" }}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        style={{ display: "grid", gap: 3, width: "100%", textAlign: "left", background: "none", border: "none", padding: "9px 12px", color: "inherit", cursor: "pointer", font: "inherit", minWidth: 0 }}
      >
        <span style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", minWidth: 0 }}>
          <Pill size="sm" tone={outbound ? "info" : "neutral"}>{outbound ? "Sent" : "Received"}</Pill>
          <span style={{ fontSize: 13, fontWeight: 600, overflowWrap: "anywhere" }}>{outbound ? `To ${message.to.map(who).join(", ") || "–"}` : who(message.from)}</span>
          {message.replyingTo ? <Pill size="sm" tone="accent">Replying to this</Pill> : null}
          <span style={{ fontSize: 12, color: tokens.muted, marginLeft: "auto" }}>{message.at ? formatDateTime(message.at) : ""}</span>
        </span>
        {!open && message.snippet ? <span style={{ fontSize: 12.5, color: tokens.muted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{message.snippet}</span> : null}
        {!open && message.private ? <span style={{ fontSize: 12.5, color: tokens.muted }}>Private client mail: the text is not shown here.</span> : null}
      </button>
      {open ? (
        <div style={{ padding: "0 12px 10px", display: "grid", gap: 6, minWidth: 0 }}>
          {!body ? <p style={muted}>Loading the message…</p> : null}
          {body?.text ? <div style={{ fontSize: 13, lineHeight: 1.5, whiteSpace: "pre-wrap", overflowWrap: "anywhere", maxHeight: 320, overflowY: "auto" }}>{body.text}</div> : null}
          {body?.note ? <p style={muted}>{body.note}</p> : null}
          {body?.truncated ? <p style={muted}>This is long, so only the start is shown. Open Gmail for the rest.</p> : null}
          {message.files ? <p style={muted}>{message.files} file{message.files === 1 ? "" : "s"} attached</p> : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Under a mail or draft: the tasks agents work on for it, then the other messages in its thread.
 * A draft opens the message it answers, so the reader sees what is being replied to before sending.
 */
export function MailContext({ messageId }: { messageId: string }) {
  const load = usePluginAction("mailbox.thread-context");
  const navigation = useHostNavigation();
  const [data, setData] = useState<ThreadContext | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setData(null);
    setProblem(null);
    (load({ messageId }) as Promise<ThreadContext>)
      .then((out) => {
        if (live) setData(out);
      })
      .catch((error: unknown) => {
        if (live) setProblem(errorText(error));
      });
    return () => {
      live = false;
    };
  }, [messageId]); // eslint-disable-line react-hooks/exhaustive-deps

  if (problem) return <p style={muted}>The thread and tasks could not load: {problem}</p>;
  if (!data) return <p style={muted}>Loading the thread and tasks…</p>;

  const others = data.messages.filter((message) => !message.current);
  return (
    <div style={{ display: "grid", gap: 14, minWidth: 0 }}>
      <section style={{ display: "grid", gap: 6, minWidth: 0 }} aria-label="Linked tasks">
        <h3 style={heading}>Linked tasks{data.tasks.length ? ` (${data.tasks.length + data.moreTasks})` : ""}</h3>
        {data.tasks.length === 0 ? <p style={muted}>No task is linked to this mail yet.</p> : null}
        {data.tasks.map((task) => (
          <a
            key={task.id}
            {...navigation.linkProps(taskHref(task))}
            style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginLeft: Math.min(task.depth, 3) * 16, padding: "7px 10px", border: `1px solid ${tokens.border}`, borderRadius: 10, color: "inherit", textDecoration: "none", minWidth: 0 }}
          >
            <Pill size="sm" tone={taskTone(task.status)} dot>{taskStatusName(task.status)}</Pill>
            <span style={{ fontSize: 13, fontWeight: 600, flex: "1 1 200px", minWidth: 0, overflowWrap: "anywhere" }}>{task.identifier ? `${task.identifier} · ` : ""}{task.title}</span>
            <span style={{ fontSize: 12, color: tokens.muted }}>{[task.assignee, taskLinkName(task.link)].filter(Boolean).join(" · ")}</span>
          </a>
        ))}
        {data.moreTasks ? <p style={muted}>And {data.moreTasks} more under these tasks.</p> : null}
      </section>
      {others.length ? (
        <section style={{ display: "grid", gap: 6, minWidth: 0 }} aria-label="Previous correspondence">
          <h3 style={heading}>In this thread ({others.length + data.moreMessages})</h3>
          {data.moreMessages ? <p style={muted}>The {data.moreMessages} oldest are not shown. Open Gmail for those.</p> : null}
          {others.map((message) => <ThreadRow key={message.id} message={message} startOpen={message.replyingTo} />)}
        </section>
      ) : null}
    </div>
  );
}
