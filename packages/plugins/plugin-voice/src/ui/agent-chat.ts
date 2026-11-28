/**
 * The live voice's line to an agent. Every finished thing the person says is posted, by code, as their own
 * comment on that agent's Agent Chat issue, exactly as the text chat posts it. The comment wakes a normal
 * agent run, so voice gets the agent's full tools, subagents and long-running work, and the chat thread is
 * the record even if the call drops. The realtime model has no tools and does not decide what is sent.
 */

import type { CallContext } from "./call-context.js";

export interface ApiClient {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body: unknown): Promise<T>;
}

export interface AgentChatContext {
  api: ApiClient;
  companyId: string;
  /** Agent to talk to (id, url key or name), e.g. from a `/PAR/chats/pib` page. Null: the company's CEO. */
  agentRef: string | null;
  /** Where the call was opened (frozen at mount): names the task in each message and carries the first-turn block. */
  context: CallContext;
  /** Direct voice mode: each turn asks the agent to answer in short spoken sentences. */
  direct?: boolean;
}

export interface ChatTarget {
  issueId: string;
  ref: string;
  agentName: string;
  /** The chat's agent: only its own comments count as the reply in direct mode. */
  agentId: string | null;
  /** The agent the call asked for could not be reached (404 on its chat); this chat is the default agent's. */
  fellBack?: { from: string };
}

/** The comment a turn was posted as, so replies can be read from that point on. */
export interface PostedTurn {
  target: ChatTarget;
  commentId: string | null;
  createdAt: string | null;
}

export interface AgentRow {
  id: string;
  name: string;
  urlKey?: string | null;
  role?: string | null;
  status?: string | null;
}

interface ChatIssueRow {
  id: string;
  identifier?: string | null;
  assigneeAgentId?: string | null;
  /** Set on a chat issue; the agent the chat is with, even if the assignee field is empty. */
  conversationAgentId?: string | null;
}

const MAX_BODY = 700;
const INACTIVE = new Set(["terminated", "archived", "deleted"]);

/** A failed API call that kept its HTTP status. */
export function isNotFound(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { status?: unknown }).status === 404;
}

export function clip(text: string | null | undefined, max = MAX_BODY): string {
  const clean = (text ?? "").replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/** `/PAR/chats/pib` -> `pib`; any other page -> null. */
export function agentRefFromPath(pathname: string): string | null {
  const m = /^\/[^/]+\/chats\/([^/?#]+)/.exec(pathname);
  return m ? decodeURIComponent(m[1]!) : null;
}

/** The agent a call talks to when none is named: the CEO, else the first active agent. */
export function defaultAgent(agents: AgentRow[]): AgentRow | null {
  const active = agents.filter((a) => !INACTIVE.has(String(a.status ?? "").toLowerCase()));
  return active.find((a) => String(a.role ?? "").toLowerCase() === "ceo") ?? active[0] ?? null;
}

/** The agent a call is with: the one named by the page (id, url key or name), else the default. */
export function agentForCall(agents: AgentRow[], ref: string | null): AgentRow | null {
  if (ref) {
    const r = ref.toLowerCase();
    const hit = agents.find((a) => a.id === ref || String(a.urlKey ?? "").toLowerCase() === r || a.name.toLowerCase() === r);
    if (hit) return hit;
  }
  return defaultAgent(agents);
}

/**
 * What the agent sees: the words as spoken, then (first sent turn on a task only) the fenced task block, then
 * where the words came from. `about` is `from PAR-x` or `about PAR-x: "<title>"`; null on a chat.
 */
export function chatBody(text: string, opts: { about: string | null; direct: boolean; block: string | null }): string {
  const footer = `_Sent by voice${opts.about ? ` ${opts.about}` : ""}${opts.direct ? ": reply in short spoken sentences" : ""}._`;
  return [text.trim(), opts.block, footer].filter((part) => part).join("\n\n");
}

export class AgentChat {
  private target: Promise<ChatTarget> | null = null;
  private agentsCache: AgentRow[] | null = null;
  private voiceCapability: Promise<boolean> | null = null;

  constructor(private readonly ctx: AgentChatContext) {}

  private async agents(): Promise<AgentRow[]> {
    if (!this.agentsCache) this.agentsCache = await this.ctx.api.get<AgentRow[]>(`/companies/${this.ctx.companyId}/agents`);
    return this.agentsCache;
  }

  /**
   * Whether the server can store the `voice` comment field (health `capabilities.voiceCommentMetadata`).
   * Read once per call; a failed or missing read means no, so the turn posts exactly as before.
   */
  private serverStoresVoiceField(): Promise<boolean> {
    if (!this.voiceCapability) {
      this.voiceCapability = this.ctx.api
        .get<{ capabilities?: { voiceCommentMetadata?: unknown } } | null>("/health")
        .then((h) => typeof h?.capabilities?.voiceCommentMetadata === "number" && h.capabilities.voiceCommentMetadata >= 1)
        .catch(() => false);
    }
    return this.voiceCapability;
  }

  /** The chat issue, fetched or created once per call (the server's ensure is idempotent). A failure is retried next time. */
  resolve(): Promise<ChatTarget> {
    if (!this.target) {
      this.target = this.ensure().catch((err: unknown) => {
        this.target = null;
        throw err;
      });
    }
    return this.target;
  }

  private async ensure(): Promise<ChatTarget> {
    let ref = this.ctx.agentRef;
    if (!ref) {
      const agent = defaultAgent(await this.agents());
      if (!agent) throw new Error("There is no agent to talk to in this company.");
      ref = agent.id;
    }
    let issue: ChatIssueRow;
    let fellBack: { from: string } | undefined;
    try {
      issue = await this.ctx.api.post<ChatIssueRow>(`/companies/${this.ctx.companyId}/chats/${encodeURIComponent(ref)}`, {});
    } catch (err) {
      // The agent is off this person's list (or gone): talk with the default agent once, said out loud by the session.
      const fallback = isNotFound(err) ? await this.fallbackAgent(ref) : null;
      if (!fallback) throw err;
      issue = await this.ctx.api.post<ChatIssueRow>(`/companies/${this.ctx.companyId}/chats/${encodeURIComponent(fallback.agent.id)}`, {});
      ref = fallback.agent.id;
      fellBack = { from: fallback.from };
    }
    const agents = await this.agents();
    // The chat's own agent decides whose voice speaks and whose comments count as the reply. An older chat can
    // have an empty assignee, so fall back to the conversation agent, then to the agent the call asked for.
    const asked = agents.find((a) => a.id === ref || String(a.urlKey ?? "").toLowerCase() === ref.toLowerCase() || a.name.toLowerCase() === ref.toLowerCase());
    const agentId = issue.conversationAgentId ?? issue.assigneeAgentId ?? asked?.id ?? null;
    const agent = agents.find((a) => a.id === agentId);
    return { issueId: issue.id, ref: issue.identifier ?? issue.id, agentName: agent?.name ?? "The agent", agentId, ...(fellBack ? { fellBack } : {}) };
  }

  /** The default agent, and the name of the one that 404ed; null when `ref` already is the default (today's retry path). */
  private async fallbackAgent(ref: string): Promise<{ agent: AgentRow; from: string } | null> {
    let agents: AgentRow[];
    try {
      agents = await this.agents();
    } catch {
      return null;
    }
    const agent = defaultAgent(agents);
    if (!agent) return null;
    const r = ref.toLowerCase();
    const matches = (a: AgentRow) => a.id === ref || String(a.urlKey ?? "").toLowerCase() === r || a.name.toLowerCase() === r;
    if (matches(agent)) return null;
    return { agent, from: agents.find(matches)?.name ?? ref };
  }

  /**
   * Posts one turn. `clientRequestId` is fixed per turn by the caller, so a retry after a lost response
   * cannot post it twice.
   */
  async submit(text: string, clientRequestId: string): Promise<ChatTarget> {
    return (await this.post(text, clientRequestId)).target;
  }

  /** `submit`, plus the posted comment's id and time as the server answered them. */
  async post(text: string, clientRequestId: string): Promise<PostedTurn> {
    const target = await this.resolve();
    const { context } = this.ctx;
    const task = context.kind === "task" ? context : null;
    // Only a Direct spoken turn is marked; typed chat and the classic voice path never carry the field.
    const marked = (this.ctx.direct ?? false) && (await this.serverStoresVoiceField());
    const row = await this.ctx.api.post<{ id?: unknown; createdAt?: unknown } | null>(`/issues/${target.issueId}/comments`, {
      body: chatBody(text, {
        about: task?.aboutLine ?? null,
        direct: this.ctx.direct ?? false,
        // A retry of this turn carries it again (same clientRequestId); a turn that never landed leaves the flag unset.
        block: context.blockSent ? null : (task?.block ?? null),
      }),
      clientRequestId,
      ...(marked ? { metadata: { version: 1, voice: { mode: "direct" }, sections: [] } } : {}),
    });
    if (row && typeof row === "object") context.blockSent = true;
    return {
      target,
      commentId: typeof row?.id === "string" ? row.id : null,
      createdAt: typeof row?.createdAt === "string" ? row.createdAt : null,
    };
  }
}
