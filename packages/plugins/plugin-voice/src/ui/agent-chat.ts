/**
 * The live voice's line to an agent. Every finished thing the person says is posted, by code, as their own
 * comment on that agent's Agent Chat issue, exactly as the text chat posts it. The comment wakes a normal
 * agent run, so voice gets the agent's full tools, subagents and long-running work, and the chat thread is
 * the record even if the call drops. The realtime model has no tools and does not decide what is sent.
 */

export interface ApiClient {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body: unknown): Promise<T>;
}

export interface AgentChatContext {
  api: ApiClient;
  companyId: string;
  /** Agent to talk to (id, url key or name), e.g. from a `/PAR/chats/pib` page. Null: the company's CEO. */
  agentRef: string | null;
  /** Task on screen when the call started, named in each message so "this task" means something to the agent. */
  pageIssueRef: string | null;
  /** Direct voice mode: each turn asks the agent to answer in short spoken sentences. */
  direct?: boolean;
}

export interface ChatTarget {
  issueId: string;
  ref: string;
  agentName: string;
  /** The chat's agent: only its own comments count as the reply in direct mode. */
  agentId: string | null;
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

/** What the agent sees: the words as spoken, plus where they came from. */
export function chatBody(text: string, pageIssueRef: string | null, direct = false): string {
  return `${text.trim()}\n\n_Sent by voice${pageIssueRef ? ` from ${pageIssueRef}` : ""}${direct ? ": reply in short spoken sentences" : ""}._`;
}

export class AgentChat {
  private target: Promise<ChatTarget> | null = null;
  private agentsCache: AgentRow[] | null = null;

  constructor(private readonly ctx: AgentChatContext) {}

  private async agents(): Promise<AgentRow[]> {
    if (!this.agentsCache) this.agentsCache = await this.ctx.api.get<AgentRow[]>(`/companies/${this.ctx.companyId}/agents`);
    return this.agentsCache;
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
    const issue = await this.ctx.api.post<ChatIssueRow>(`/companies/${this.ctx.companyId}/chats/${encodeURIComponent(ref)}`, {});
    const agents = await this.agents();
    // The chat's own agent decides whose voice speaks and whose comments count as the reply. An older chat can
    // have an empty assignee, so fall back to the conversation agent, then to the agent the call asked for.
    const asked = agents.find((a) => a.id === ref || String(a.urlKey ?? "").toLowerCase() === ref.toLowerCase() || a.name.toLowerCase() === ref.toLowerCase());
    const agentId = issue.conversationAgentId ?? issue.assigneeAgentId ?? asked?.id ?? null;
    const agent = agents.find((a) => a.id === agentId);
    return { issueId: issue.id, ref: issue.identifier ?? issue.id, agentName: agent?.name ?? "The agent", agentId };
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
    const row = await this.ctx.api.post<{ id?: unknown; createdAt?: unknown } | null>(`/issues/${target.issueId}/comments`, {
      body: chatBody(text, this.ctx.pageIssueRef, this.ctx.direct ?? false),
      clientRequestId,
    });
    return {
      target,
      commentId: typeof row?.id === "string" ? row.id : null,
      createdAt: typeof row?.createdAt === "string" ? row.createdAt : null,
    };
  }
}
