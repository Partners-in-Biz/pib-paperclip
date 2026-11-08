/**
 * What a mail is connected to, for the Mailbox page: the correspondence around it and the tasks agents work on for it.
 *
 * A task is linked when it is the thread's reply task (`thread_issues`), a person gave the mail or thread to an agent
 * (hand-off link), the agent's run was working on it when it saved a draft (`draft.sourceIssueId`), or a person asked
 * for a rewrite. The subtasks under those come with them. Private client mail keeps its text hidden here too.
 */
import { MailboxError } from "./domain.js";
import type { MessageRow } from "./gmail/types.js";

export type TaskLinkKind = "reply" | "handoff" | "draft" | "rewrite" | "subtask";

export interface LinkIssue {
  id: string;
  identifier?: string | null;
  title: string;
  status: string;
  parentId?: string | null;
  assigneeAgentId?: string | null;
  hiddenAt?: unknown;
}

export interface LinkSubtree {
  issues: LinkIssue[];
  assignees?: Record<string, { name: string }>;
}

/** The light columns the list chips need; no bodies or draft files. */
export interface MessageLinkRow {
  id: string;
  account_id: string;
  status: string;
  gmail_thread_id: string | null;
  gmail_message_id: string | null;
  draft_thread_id: string | null;
  reply_to_id: string | null;
  source_issue_id: string | null;
  rewrite_issue_id: string | null;
}

export interface MailLinksDeps {
  findMessage(id: string): Promise<MessageRow | null>;
  threadMessages(threadId: string): Promise<MessageRow[]>;
  isPrivate(row: MessageRow): Promise<boolean>;
  threadIssueId(accountId: string, threadId: string): Promise<string | null>;
  handoffIssueIds(messageId: string): Promise<string[]>;
  subtree(issueId: string, withNames: boolean): Promise<LinkSubtree | null>;
  linkRows(ids: string[]): Promise<MessageLinkRow[]>;
  threadIssueRows(threadIds: string[]): Promise<Array<{ account_id: string; gmail_thread_id: string; issue_id: string }>>;
}

const MAX_THREAD = 50;
const MAX_TASKS = 30;
const MAX_IDS = 200;
const SNIPPET = 240;
const CLOSED = new Set(["done", "cancelled"]);

const time = (row: MessageRow) => row.received_at ?? row.created_at ?? "";

/** Runs `work` on each item, a few at a time: every call is a round trip to the host. */
async function pool<T, R>(items: T[], size: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await work(items[i]!);
      }
    }),
  );
  return out;
}

/** Each issue once: parents before their children, with how deep it sits under the root. */
function treeOrder(issues: LinkIssue[], rootId: string): Array<{ issue: LinkIssue; depth: number }> {
  const children = new Map<string, LinkIssue[]>();
  for (const issue of issues) {
    if (issue.id === rootId || !issue.parentId) continue;
    children.set(issue.parentId, [...(children.get(issue.parentId) ?? []), issue]);
  }
  const out: Array<{ issue: LinkIssue; depth: number }> = [];
  const seen = new Set<string>();
  const walk = (issue: LinkIssue, depth: number) => {
    if (seen.has(issue.id)) return;
    seen.add(issue.id);
    out.push({ issue, depth });
    for (const child of children.get(issue.id) ?? []) walk(child, depth + 1);
  };
  const root = issues.find((issue) => issue.id === rootId);
  if (root) walk(root, 0);
  // Anything whose parent was not in the answer still shows.
  for (const issue of issues) walk(issue, 1);
  return out;
}

/** The thread around a mail or draft (oldest first) and the tasks linked to it, for the page's detail view. */
export async function threadContext(deps: MailLinksDeps, messageId: string) {
  const row = await deps.findMessage(messageId);
  if (!row) throw new MailboxError("Message not found");
  const replyToId = row.status === "draft" ? row.draft?.replyToMessageId ?? null : null;
  const original = replyToId ? await deps.findMessage(replyToId) : null;
  const anchor = original ?? row;
  const threadId = anchor.gmail_thread_id ?? row.draft?.threadId ?? null;

  const inThread = threadId ? (await deps.threadMessages(threadId)).filter((m) => m.account_id === row.account_id) : [];
  const sent = inThread.filter((m) => m.status !== "draft");
  if (anchor.status !== "draft" && !sent.some((m) => m.id === anchor.id)) sent.push(anchor);
  sent.sort((a, b) => time(a).localeCompare(time(b)));
  const shown = sent.slice(-MAX_THREAD);

  const messages = await pool(shown, 6, async (m) => {
    const hidden = await deps.isPrivate(m);
    return {
      id: m.id,
      direction: m.direction,
      subject: m.subject,
      from: m.from_addr ?? null,
      to: m.to_addrs ?? [],
      at: time(m) || null,
      snippet: hidden ? null : (m.snippet ?? m.body ?? "").slice(0, SNIPPET) || null,
      private: hidden,
      files: (m.attachments ?? []).length,
      current: m.id === row.id,
      replyingTo: m.id === original?.id,
    };
  });

  const roots = new Map<string, TaskLinkKind>();
  const add = (id: string | null | undefined, kind: TaskLinkKind) => {
    if (id && !roots.has(id)) roots.set(id, kind);
  };
  const threadKey = threadId ?? anchor.gmail_message_id;
  if (threadKey) add(await deps.threadIssueId(row.account_id, threadKey), "reply");
  for (const ids of await pool(shown, 6, (m) => deps.handoffIssueIds(m.id))) for (const id of ids) add(id, "handoff");
  if (!shown.some((m) => m.id === row.id)) for (const id of await deps.handoffIssueIds(row.id)) add(id, "handoff");
  add(row.draft?.sourceIssueId, "draft");
  for (const m of inThread) add(m.draft?.sourceIssueId, "draft");
  add(row.draft?.rewrite?.issueId, "rewrite");

  const tasks: Array<{ id: string; identifier: string | null; title: string; status: string; assignee: string | null; link: TaskLinkKind; depth: number }> = [];
  const seen = new Set<string>();
  for (const [rootId, kind] of roots) {
    const tree = await deps.subtree(rootId, true);
    if (!tree) continue;
    for (const { issue, depth } of treeOrder(tree.issues, rootId)) {
      if (seen.has(issue.id) || issue.hiddenAt) continue;
      seen.add(issue.id);
      tasks.push({
        id: issue.id,
        identifier: issue.identifier ?? null,
        title: issue.title,
        status: issue.status,
        assignee: issue.assigneeAgentId ? tree.assignees?.[issue.assigneeAgentId]?.name ?? null : null,
        link: issue.id === rootId ? kind : "subtask",
        depth,
      });
    }
  }
  return { threadId, messages, moreMessages: sent.length - shown.length, tasks: tasks.slice(0, MAX_TASKS), moreTasks: Math.max(0, tasks.length - MAX_TASKS) };
}

export interface TaskLinkSummary {
  primary: { id: string; identifier: string | null; title: string; status: string };
  total: number;
  open: number;
}

/** One line per mail for the Inbox and Drafts lists: its first linked task, and how many there are. A task that can't be read is left out. */
export async function taskLinks(deps: MailLinksDeps, messageIds: string[]): Promise<Record<string, TaskLinkSummary>> {
  const ids = [...new Set(messageIds)].slice(0, MAX_IDS);
  if (ids.length === 0) return {};
  const rows = await deps.linkRows(ids);
  const missing = rows.filter((r) => !r.gmail_thread_id && !r.draft_thread_id && r.reply_to_id).map((r) => r.reply_to_id as string);
  const originals = new Map((missing.length ? await deps.linkRows(missing) : []).map((r) => [r.id, r]));
  const threadOf = (r: MessageLinkRow) =>
    r.gmail_thread_id ?? r.draft_thread_id ?? (r.reply_to_id ? originals.get(r.reply_to_id)?.gmail_thread_id ?? originals.get(r.reply_to_id)?.gmail_message_id ?? null : r.gmail_message_id);
  const threadKeyOf = (r: MessageLinkRow) => {
    const thread = threadOf(r);
    return thread ? `${r.account_id}:${thread}` : `message:${r.id}`;
  };

  const rootsByThread = new Map<string, string[]>();
  const addRoot = (key: string, issueId: string | null | undefined) => {
    if (!issueId) return;
    const list = rootsByThread.get(key) ?? [];
    if (!list.includes(issueId)) list.push(issueId);
    rootsByThread.set(key, list);
  };
  const threadIds = [...new Set(rows.map(threadOf).filter((t): t is string => Boolean(t)))];
  for (const link of await deps.threadIssueRows(threadIds)) addRoot(`${link.account_id}:${link.gmail_thread_id}`, link.issue_id);
  const handoffs = await pool(rows, 8, (r) => (r.status === "draft" ? Promise.resolve([] as string[]) : deps.handoffIssueIds(r.id)));
  rows.forEach((r, i) => {
    const key = threadKeyOf(r);
    for (const id of handoffs[i]!) addRoot(key, id);
    addRoot(key, r.source_issue_id);
    addRoot(key, r.rewrite_issue_id);
  });

  const allRoots = [...new Set([...rootsByThread.values()].flat())];
  const trees = await pool(allRoots, 6, (id) => deps.subtree(id, false));
  const treeBy = new Map(allRoots.map((id, i) => [id, trees[i] ?? null]));

  const byThread = new Map<string, TaskLinkSummary>();
  for (const [key, roots] of rootsByThread) {
    const issues = new Map<string, LinkIssue>();
    let primary: LinkIssue | null = null;
    for (const rootId of roots) {
      const tree = treeBy.get(rootId);
      if (!tree) continue;
      primary ??= tree.issues.find((issue) => issue.id === rootId) ?? null;
      for (const issue of tree.issues) if (!issue.hiddenAt) issues.set(issue.id, issue);
    }
    if (!primary) continue;
    byThread.set(key, {
      primary: { id: primary.id, identifier: primary.identifier ?? null, title: primary.title, status: primary.status },
      total: issues.size,
      open: [...issues.values()].filter((issue) => !CLOSED.has(issue.status)).length,
    });
  }
  const out: Record<string, TaskLinkSummary> = {};
  for (const r of rows) {
    const summary = byThread.get(threadKeyOf(r));
    if (summary) out[r.id] = summary;
  }
  return out;
}
