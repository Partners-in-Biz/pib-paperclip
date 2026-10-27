/**
 * The live voice's tools. They run in the browser against Paperclip's own API
 * with the signed-in person's session, so the voice can do exactly what that
 * person can do in the app, and every change is logged as theirs.
 *
 * Changes (posting a message, creating a task) are two steps. The first call
 * stores a pending action and returns a read-back and a `confirmationId`. The
 * second call must carry that id, and it is accepted only after the person has
 * spoken again since the read-back (`userTurn` has moved on). The stored action
 * runs, not the arguments of the second call, and it is cleared after one use.
 */

import { newUuid } from "./uuid.js";

export interface ApiClient {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body: unknown): Promise<T>;
}

export interface ToolContext {
  api: ApiClient;
  companyId: string;
  userId: string | null;
  /** Issue on screen when the session started, e.g. "PAR-123". */
  pageIssueRef: string | null;
  /** Issues the voice posted to; their agent replies are read out. */
  watch: (issueId: string, ref: string) => void;
  /** Count of finished spoken turns from the person; a confirmation needs a new one. */
  userTurn: () => number;
}

interface PendingAction {
  id: string;
  turn: number;
  run: () => Promise<unknown>;
}

interface AgentRow {
  id: string;
  name: string;
  title?: string | null;
  role?: string | null;
  status?: string | null;
}

interface IssueRow {
  id: string;
  identifier?: string | null;
  title: string;
  status: string;
  priority?: string | null;
  description?: string | null;
  assigneeAgentId?: string | null;
  assigneeUserId?: string | null;
  updatedAt?: string | null;
}

interface CommentRow {
  id: string;
  body: string;
  authorAgentId?: string | null;
  authorUserId?: string | null;
  createdAt?: string | null;
}

interface ProjectRow {
  id: string;
  name: string;
  archivedAt?: string | null;
}

export const TOOL_DEFINITIONS = [
  {
    type: "function",
    name: "get_page_context",
    description: "What the person is looking at: the task on screen (if any) with its latest messages. Call this first when they say 'this task' or 'this'.",
    parameters: { type: "object", properties: {} },
  },
  {
    type: "function",
    name: "what_needs_me",
    description: "Tasks waiting on the person: assigned to them or waiting for their review, newest first.",
    parameters: { type: "object", properties: {} },
  },
  {
    type: "function",
    name: "find_tasks",
    description: "Search tasks by words in the title, and/or by status or the agent working on them.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Words to look for, e.g. 'Hunt and Gun SEO'." },
        status: { type: "string", enum: ["backlog", "todo", "in_progress", "in_review", "blocked", "done", "cancelled", "open"], description: "'open' means anything not done or cancelled." },
        agent: { type: "string", description: "Name of the agent the task is assigned to." },
      },
    },
  },
  {
    type: "function",
    name: "get_task",
    description: "One task in detail with its latest messages.",
    parameters: {
      type: "object",
      properties: { ref: { type: "string", description: "Task id like PAR-123." } },
      required: ["ref"],
    },
  },
  {
    type: "function",
    name: "list_agents",
    description: "The agents in this company with their roles and whether they are active.",
    parameters: { type: "object", properties: {} },
  },
  {
    type: "function",
    name: "post_message",
    description: "Post a message on a task as the person. This wakes the agent assigned to it. Call first to get a readBack and a confirmationId, read it back, and only after the person says yes call again with that confirmationId.",
    parameters: {
      type: "object",
      properties: {
        ref: { type: "string", description: "Task id like PAR-123. Omit to use the task on screen." },
        text: { type: "string", description: "The message, written as the person would write it." },
        confirmationId: { type: "string", description: "The id from the preview, sent only after the person said yes to the read-back." },
      },
      required: ["text"],
    },
  },
  {
    type: "function",
    name: "create_task",
    description: "Create a new task and assign it to an agent. Call first to get a readBack and a confirmationId, read it back, and only after the person says yes call again with that confirmationId.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string" },
        description: { type: "string", description: "What needs doing and what done looks like." },
        agent: { type: "string", description: "Agent name to assign it to." },
        project: { type: "string", description: "Project name, when the person names one." },
        confirmationId: { type: "string", description: "The id from the preview, sent only after the person said yes to the read-back." },
      },
      required: ["title", "agent"],
    },
  },
  {
    type: "function",
    name: "check_replies",
    description: "New messages on the tasks posted to in this conversation.",
    parameters: { type: "object", properties: {} },
  },
] as const;

export type ToolName = (typeof TOOL_DEFINITIONS)[number]["name"];

const OPEN_STATUSES = "backlog,todo,in_progress,in_review,blocked";
const MAX_BODY = 700;

export function clip(text: string | null | undefined, max = MAX_BODY): string {
  const clean = (text ?? "").replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function norm(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** Spoken names are loose: "the SEO guy", "seo specialist", "Kai". */
export function matchByName<T extends { name: string }>(rows: T[], spoken: string): T | null {
  const want = norm(spoken);
  if (!want) return null;
  const exact = rows.find((r) => norm(r.name) === want);
  if (exact) return exact;
  const contains = rows.filter((r) => norm(r.name).includes(want) || want.includes(norm(r.name)));
  if (contains.length === 1) return contains[0]!;
  const words = want.split(" ").filter((w) => w.length > 2);
  const scored = rows
    .map((r) => ({ r, score: words.filter((w) => norm(r.name).includes(w)).length }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
  if (scored.length === 1 || (scored.length > 1 && scored[0]!.score > scored[1]!.score)) return scored[0]!.r;
  return null;
}

export class LiveTools {
  private agentCache: AgentRow[] | null = null;
  private pending: PendingAction | null = null;
  private seq = 0;

  constructor(private readonly ctx: ToolContext) {}

  private async agents(): Promise<AgentRow[]> {
    if (!this.agentCache) {
      this.agentCache = await this.ctx.api.get<AgentRow[]>(`/companies/${this.ctx.companyId}/agents`);
    }
    return this.agentCache;
  }

  private async agentName(id: string | null | undefined): Promise<string | null> {
    if (!id) return null;
    const agent = (await this.agents()).find((a) => a.id === id);
    return agent?.name ?? "an agent";
  }

  private async summarizeIssue(issue: IssueRow) {
    return {
      ref: issue.identifier ?? issue.id,
      title: issue.title,
      status: issue.status,
      assignee: (await this.agentName(issue.assigneeAgentId)) ?? (issue.assigneeUserId ? (issue.assigneeUserId === this.ctx.userId ? "you" : "a person") : "nobody"),
    };
  }

  private async issueWithMessages(ref: string, count = 6) {
    const issue = await this.ctx.api.get<IssueRow>(`/issues/${encodeURIComponent(ref)}`);
    const comments = await this.ctx.api.get<CommentRow[]>(`/issues/${issue.id}/comments?order=desc&limit=${count}`);
    const messages = [];
    for (const c of [...comments].reverse()) {
      messages.push({
        from: c.authorAgentId ? await this.agentName(c.authorAgentId) : c.authorUserId === this.ctx.userId ? "you" : "a person",
        at: c.createdAt ?? null,
        text: clip(c.body),
      });
    }
    return {
      issue,
      summary: { ...(await this.summarizeIssue(issue)), priority: issue.priority ?? null, description: clip(issue.description, 500), messages },
    };
  }

  private async resolveRef(ref: unknown): Promise<string> {
    const given = typeof ref === "string" ? ref.trim() : "";
    if (given) return given.toUpperCase().replace(/\s+/g, "");
    if (this.ctx.pageIssueRef) return this.ctx.pageIssueRef;
    throw new Error("Which task? Ask for the task id, like PAR-123.");
  }

  /** Returns the stored action when the id matches and the person spoke since the read-back. */
  private takeConfirmed(id: unknown): PendingAction | { error: string } | null {
    if (typeof id !== "string" || !id) return null;
    const p = this.pending;
    if (!p || p.id !== id) return { error: "That confirmation is not valid. Preview the change again and read it back." };
    if (this.ctx.userTurn() <= p.turn) return { error: "Wait for the person to answer the read-back before confirming." };
    this.pending = null;
    return p;
  }

  private stage(readBack: string, run: () => Promise<unknown>): unknown {
    const id = `c${++this.seq}`;
    this.pending = { id, turn: this.ctx.userTurn(), run };
    return { needsConfirmation: true, confirmationId: id, readBack };
  }

  async run(name: string, args: Record<string, unknown>): Promise<unknown> {
    switch (name) {
      case "get_page_context": {
        if (!this.ctx.pageIssueRef) return { onScreen: "no task open", hint: "Ask what they want, or use what_needs_me." };
        return (await this.issueWithMessages(this.ctx.pageIssueRef)).summary;
      }
      case "what_needs_me": {
        if (!this.ctx.userId) return { tasks: [] };
        const mine = await this.ctx.api.get<IssueRow[]>(
          `/companies/${this.ctx.companyId}/issues?assigneeUserId=me&status=${OPEN_STATUSES}&limit=10&sortField=updated&sortDir=desc`,
        );
        return { count: mine.length, tasks: await Promise.all(mine.map((i) => this.summarizeIssue(i))) };
      }
      case "find_tasks": {
        const params = new URLSearchParams({ limit: "8", sortField: "updated", sortDir: "desc" });
        if (typeof args.query === "string" && args.query.trim()) params.set("q", args.query.trim());
        if (typeof args.status === "string" && args.status) params.set("status", args.status === "open" ? OPEN_STATUSES : args.status);
        if (typeof args.agent === "string" && args.agent.trim()) {
          const agent = matchByName(await this.agents(), args.agent);
          if (!agent) return { error: `No agent called ${args.agent}.`, agents: (await this.agents()).map((a) => a.name) };
          params.set("assigneeAgentId", agent.id);
        }
        const rows = await this.ctx.api.get<IssueRow[]>(`/companies/${this.ctx.companyId}/issues?${params.toString()}`);
        return { count: rows.length, tasks: await Promise.all(rows.map((i) => this.summarizeIssue(i))) };
      }
      case "get_task":
        return (await this.issueWithMessages(await this.resolveRef(args.ref))).summary;
      case "list_agents":
        return {
          agents: (await this.agents()).map((a) => ({ name: a.name, role: a.title ?? a.role ?? null, status: a.status ?? null })),
        };
      case "post_message": {
        const ref = await this.resolveRef(args.ref);
        const text = typeof args.text === "string" ? args.text.trim() : "";
        if (!text) return { error: "The message is empty." };
        const confirmed = this.takeConfirmed(args.confirmationId);
        if (confirmed && "error" in confirmed) return confirmed;
        if (confirmed) return confirmed.run();
        const issue = await this.ctx.api.get<IssueRow>(`/issues/${encodeURIComponent(ref)}`);
        const target = (await this.agentName(issue.assigneeAgentId)) ?? "nobody (no agent will wake)";
        return this.stage(`Post to ${issue.identifier ?? ref} (${issue.title}), going to ${target}: "${text}"`, async () => {
          await this.ctx.api.post(`/issues/${issue.id}/comments`, { body: text, clientRequestId: newUuid() });
          this.ctx.watch(issue.id, issue.identifier ?? ref);
          return { posted: true, task: issue.identifier ?? ref, wakes: target };
        });
      }
      case "create_task": {
        const confirmed = this.takeConfirmed(args.confirmationId);
        if (confirmed && "error" in confirmed) return confirmed;
        if (confirmed) return confirmed.run();
        const title = typeof args.title === "string" ? args.title.trim() : "";
        if (!title) return { error: "A task needs a title." };
        const agent = typeof args.agent === "string" ? matchByName(await this.agents(), args.agent) : null;
        if (!agent) return { error: `No agent called ${String(args.agent ?? "")}.`, agents: (await this.agents()).map((a) => a.name) };
        let project: ProjectRow | null = null;
        if (typeof args.project === "string" && args.project.trim()) {
          const projects = (await this.ctx.api.get<ProjectRow[]>(`/companies/${this.ctx.companyId}/projects`)).filter((p) => !p.archivedAt);
          project = matchByName(projects, args.project);
          if (!project) return { error: `No project called ${args.project}.`, projects: projects.map((p) => p.name).slice(0, 20) };
        }
        const description = typeof args.description === "string" ? args.description.trim() : "";
        return this.stage(
          `New task "${title}" for ${agent.name}${project ? ` in ${project.name}` : ""}${description ? `: ${clip(description, 300)}` : ""}`,
          async () => {
            const created = await this.ctx.api.post<IssueRow>(`/companies/${this.ctx.companyId}/issues`, {
              title,
              description: description ? `${description}\n\n_Created by voice._` : "_Created by voice._",
              status: "todo",
              assigneeAgentId: agent.id,
              ...(project ? { projectId: project.id } : {}),
            });
            this.ctx.watch(created.id, created.identifier ?? created.id);
            return { created: true, task: created.identifier ?? created.id, assignee: agent.name };
          },
        );
      }
      default:
        return { error: `Unknown tool ${name}.` };
    }
  }
}
