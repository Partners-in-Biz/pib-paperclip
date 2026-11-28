/**
 * The Decide queue (PAR-15315, T1): the loader behind `decide.queue`, on a real Postgres with the host's tables.
 * The queue's asks and approvals are the digest's owner list; cards come from a stored index, never from a scan
 * inside the call; the call answers inside its deadline whatever hangs.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { buildOwnerDigest } from "../src/digest.js";
import { loadCompanyData, waitingSplit } from "../src/brief.js";
import { clearDecideCache, readCardIndex, refreshOwnerCards, cardsRefreshing, INDEX_STALE_MS, type DecideQueue } from "../src/decide.js";
import { readOwnerCards } from "../src/digest.js";
import { saveTeam } from "../src/roles.js";
import { COMPANY, embeddedAvailable } from "./helpers/pg.js";
import { startWorlds, type Hybrid } from "./helpers/hybrid.js";

const available = await embeddedAvailable();
const d = available ? describe : describe.skip;

const A = COMPANY;
const OP = "aaaaaaaa-0000-4000-8000-0000000000a1";
const DEV = "aaaaaaaa-0000-4000-8000-0000000000a2";
const OWNER = "user-owner";
const OTHER = "user-other";
const NOW = "2026-11-28T12:00:00.000Z";

type Context = { companyId?: string; actor?: unknown };
const realSetTimeout = globalThis.setTimeout;
const realWait = (ms: number) => new Promise<void>((resolve) => realSetTimeout(resolve, ms));
const asUser = (userId: string): Context => ({ companyId: A, actor: { type: "user", userId } });

d("the Decide queue (Postgres)", () => {
  let worlds: Awaited<ReturnType<typeof startWorlds>>;
  beforeAll(async () => {
    worlds = await startWorlds();
  }, 120_000);
  afterAll(async () => {
    await worlds?.stop();
  });
  afterEach(async () => {
    vi.useRealTimers();
    for (let i = 0; i < 100 && cardsRefreshing(A); i += 1) await new Promise((r) => setTimeout(r, 10));
    clearDecideCache();
  });

  async function make(options: Record<string, unknown> = {}) {
    clearDecideCache();
    const w = await worlds.make(
      {
        savedConfigs: { [A]: { healthIssue: true } },
        prefixes: { [A]: "PAR" },
        agents: [
          { id: OP, companyId: A, name: "Olive", status: "active", role: "general" },
          { id: DEV, companyId: A, name: "Dev", status: "active", role: "engineer" },
        ],
        ...options,
      },
      NOW,
    );
    await saveTeam(w.env, A, { operatorAgentId: OP }, OWNER);
    return w;
  }

  let n = 0;
  async function issue(w: Hybrid, title: string, extra: { status?: string; ownerAssigned?: boolean; updatedAt?: string } = {}) {
    n += 1;
    const id = `dddddddd-0000-4000-8000-${String(n).padStart(12, "0")}`;
    const identifier = `PAR-${900 + n}`;
    const status = extra.status ?? "in_progress";
    const at = extra.updatedAt ?? "2026-11-20T08:00:00.000Z";
    w.issues.set(id, { id, companyId: A, identifier, title, description: "", status, assigneeAgentId: extra.ownerAssigned ? null : DEV, assigneeUserId: extra.ownerAssigned ? OWNER : null });
    await w.client.query(
      `INSERT INTO public.issues (id, company_id, identifier, title, status, assignee_agent_id, assignee_user_id, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)`,
      [id, A, identifier, title, status, extra.ownerAssigned ? null : DEV, extra.ownerAssigned ? OWNER : null, at],
    );
    return { id, identifier };
  }

  type Interactions = (issueId: string, companyId: string) => Promise<unknown[]>;
  const setCards = (w: Hybrid, fn: Interactions) => {
    (w.ctx.issues as unknown as { listInteractions: Interactions }).listInteractions = fn;
  };
  const fixedCards = (w: Hybrid, byIssue: Record<string, Array<Record<string, unknown>>>) => setCards(w, async (id) => byIssue[id] ?? []);

  const ask = async (w: Hybrid, issueId: string, body: Record<string, unknown>) => {
    const result = (await w.tools.get("ask-owner")!({ issueId, why: "Work waits on it.", links: [{ label: "The task", href: `/PAR/issues/${issueId}` }], ...body }, { agentId: DEV, runId: "run-1", companyId: A, projectId: "" })) as { error?: string; data: { askId: string } };
    if (result.error) throw new Error(result.error);
    return result.data.askId;
  };

  const queue = (w: Hybrid, context: Context = asUser(OWNER)) => w.actions.get("decide.queue")!({}, context) as Promise<DecideQueue>;
  const settle = async (w: Hybrid) => {
    for (let i = 0; i < 200 && cardsRefreshing(A); i += 1) await new Promise((r) => setTimeout(r, 10));
    void w;
  };

  /** Advances fake time in small steps, letting real I/O run in between, until `promise` settles or `limitMs` of fake time pass. */
  /** Lets the background refresh the call started run to its end on fake time, so it frees its slot. */
  async function drainFake(w: Hybrid) {
    for (let i = 0; i < 160 && cardsRefreshing(A); i += 1) {
      await vi.advanceTimersByTimeAsync(250);
      await realWait(4);
    }
    void w;
  }

  async function runFake<T>(promise: Promise<T>, limitMs: number): Promise<{ value?: T; elapsed: number; settled: boolean }> {
    let settled = false;
    let value: T | undefined;
    promise.then((v) => {
      settled = true;
      value = v;
    });
    let elapsed = 0;
    while (!settled && elapsed < limitMs) {
      await vi.advanceTimersByTimeAsync(250);
      elapsed += 250;
      await realWait(4);
    }
    return { value, elapsed, settled };
  }

  it("agrees with the digest's owner list on asks and approvals, and leaves out cards that are not the owner's", async () => {
    const w = await make({
      approvals: [
        { id: "ap-1", companyId: A, type: "request_board_approval", status: "pending", payload: { title: "Plan the quarter", cost: 5 }, createdAt: "2026-11-21T08:00:00.000Z" },
        { id: "ap-2", companyId: A, type: "hire_agent", status: "pending", payload: { name: "New agent" }, createdAt: "2026-11-22T08:00:00.000Z" },
        { id: "ap-3", companyId: A, type: "request_board_approval", status: "approved", payload: {}, createdAt: "2026-11-22T08:00:00.000Z" },
      ],
    });
    const i1 = await issue(w, "Slimwerk deploy");
    const i2 = await issue(w, "Pricing page copy");
    const a1 = await ask(w, i1.id, { question: "Run firebase login --reauth?", kind: "grant", options: ["Yes", "No"], steps: ["Run firebase login --reauth"], links: [{ label: "Firebase console", href: "https://console.firebase.google.com" }] });
    const a2 = await ask(w, i2.id, { question: "Which headline?", kind: "decision", options: ["A", "B"] });
    const waiting = await issue(w, "Review round", { status: "in_review" });
    fixedCards(w, {
      [waiting.id]: [
        { id: "c-mine", kind: "request_confirmation", status: "pending", title: "Share the folder", payload: {}, createdAt: "2026-11-22T09:00:00.000Z" },
        { id: "c-other", kind: "request_confirmation", status: "pending", addresseeUserId: OTHER, title: "Not yours", payload: {}, createdAt: "2026-11-22T09:00:00.000Z" },
        { id: "c-agent", kind: "request_confirmation", status: "pending", addresseeAgentId: OP, title: "For an agent", payload: {}, createdAt: "2026-11-22T09:00:00.000Z" },
        { id: "c-form", kind: "ask_user_questions", status: "pending", title: "Fill in", payload: {}, createdAt: "2026-11-22T09:00:00.000Z" },
      ],
    });
    await refreshOwnerCards(w.env, A);

    const q = await queue(w);
    const entries = waitingSplit(await loadCompanyData(w.env, A, 1, 24), w.env.now()).owner;
    const digestAsks = entries.filter((e) => e.ask).map((e) => e.ask!.id).sort();
    const digestApprovals = entries.filter((e) => e.key.startsWith("host-approval:")).map((e) => e.key.slice("host-approval:".length)).sort();
    expect(digestAsks).toEqual([a1, a2].sort());
    expect(digestApprovals).toEqual(["ap-1", "ap-2"]);
    expect(q.items.filter((i) => i.ref.kind === "ask").map((i) => i.ref.id).sort()).toEqual(digestAsks);
    expect(q.items.filter((i) => i.ref.kind === "approval").map((i) => i.ref.id).sort()).toEqual(digestApprovals);
    expect(q.items.filter((i) => i.ref.kind === "card").map((i) => i.ref.id).sort()).toEqual(["c-form", "c-mine"]);
    expect(q.notOwner).toBe(false);
    expect(q.partial).toEqual([]);

    const byId = Object.fromEntries(q.items.map((i) => [i.ref.id, i]));
    expect(byId["ap-1"]).toMatchObject({ mode: "decide", options: ["Approve", "Reject"] });
    expect(byId["ap-1"]!.details).toEqual([{ label: "title", value: "Plan the quarter" }, { label: "cost", value: "5" }]);
    expect(byId["ap-2"]).toMatchObject({ mode: "open", details: [] });
    expect(byId[a1]).toMatchObject({ mode: "decide", class: "grant", options: ["Yes", "No"], recommended: null });
    expect(byId["c-mine"]!.mode).toBe("decide");
    expect(byId["c-form"]!.mode).toBe("open");
    // The grant outranks the plain decision.
    expect(q.items.findIndex((i) => i.ref.id === a1)).toBeLessThan(q.items.findIndex((i) => i.ref.id === a2));
  });

  it("gives another member an empty queue with notOwner, and refuses an agent and a missing actor", async () => {
    const w = await make();
    const i1 = await issue(w, "Slimwerk deploy");
    await ask(w, i1.id, { question: "Ship?", kind: "decision", options: ["Yes", "No"] });
    expect(await queue(w, asUser(OTHER))).toMatchObject({ items: [], notOwner: true });
    expect((await queue(w)).items).toHaveLength(1);
    for (const actor of [{ type: "agent", userId: null, agentId: DEV }, { type: "agent", userId: OWNER }, undefined, null, { type: "user" }, { type: "user", userId: "local-board" }]) {
      await expect(queue(w, { companyId: A, actor })).rejects.toThrow();
    }
    await expect(queue(w, { actor: { type: "user", userId: OWNER } })).rejects.toThrow(/Company/);
  });

  it("answers before 20 s with `partial` set when reads hang, and never scans cards inside the call", async () => {
    const w = await make();
    const i1 = await issue(w, "Slimwerk deploy", { status: "in_review" });
    await ask(w, i1.id, { question: "Ship?", kind: "decision", options: ["Yes", "No"] });
    let scans = 0;
    setCards(w, () => {
      scans += 1;
      return new Promise<unknown[]>(() => undefined);
    });
    // A loadCompanyData section that never answers.
    (w.ctx.approvals as unknown as { list: () => Promise<unknown[]> }).list = () => new Promise<unknown[]>(() => undefined);

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const run = await runFake(queue(w), 20_000);
    expect(run.settled).toBe(true);
    expect(run.elapsed).toBeLessThan(20_000);
    expect(run.value!.partial.join(" ")).toMatch(/approvals/);
    expect(run.value!.items.some((i) => i.ref.kind === "ask")).toBe(true);
    // The refresh the call started in the background has its own 5 s limit on the hung read: the call never waited for it.
    await drainFake(w);
    expect(scans).toBeGreaterThan(0);
  });

  it("cuts a hung card-index read with its own limit and still answers", async () => {
    const w = await make();
    const i1 = await issue(w, "Slimwerk deploy");
    await ask(w, i1.id, { question: "Ship?", kind: "decision", options: ["Yes", "No"] });
    // The index read itself never answers: the section guard cuts it (the 17 s outer race is only the safety net behind it).
    const realGet = w.ctx.state.get.bind(w.ctx.state);
    (w.ctx.state as unknown as { get: unknown }).get = (key: { stateKey: string }) => (key.stateKey.startsWith("decide-cards:") ? new Promise(() => undefined) : realGet(key as never));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const run = await runFake(queue(w), 20_000);
    expect(run.settled).toBe(true);
    expect(run.elapsed).toBeLessThan(20_000);
    await drainFake(w);
    expect(run.value!.partial.join(" ")).toMatch(/stored approval cards/);
    expect(run.value!.items).toHaveLength(1);
  });

  it("refreshOwnerCards finishes the other issues when one read hangs, and counts the hung one as unread", async () => {
    const w = await make();
    const hung = await issue(w, "Hung", { status: "in_review", updatedAt: "2026-11-01T00:00:00.000Z" });
    const fine = await issue(w, "Fine", { status: "in_review", updatedAt: "2026-11-02T00:00:00.000Z" });
    setCards(w, async (id) => {
      if (id === hung.id) return new Promise<unknown[]>(() => undefined);
      return [{ id: "c-fine", kind: "request_confirmation", status: "pending", title: "Accept it", payload: {}, createdAt: "2026-11-20T00:00:00.000Z" }];
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const run = await runFake(refreshOwnerCards(w.env, A), 20_000);
    expect(run.settled).toBe(true);
    expect(run.elapsed).toBeLessThan(10_000);
    expect(run.value!.pending.map((c) => c.id)).toEqual(["c-fine"]);
    expect(run.value!.unread).toMatch(/1 of 2 open tasks/);
    expect((await readCardIndex(w.env, A))!.pending).toHaveLength(1);
    void fine;
  });

  it("reads the waiting scope oldest first, and a budget cut keeps the oldest issues' cards", async () => {
    const w = await make();
    const newest = await issue(w, "Newest blocked", { status: "blocked", updatedAt: "2026-11-27T00:00:00.000Z" });
    const oldest = await issue(w, "Oldest in review", { status: "in_review", updatedAt: "2026-11-01T00:00:00.000Z" });
    const mine = await issue(w, "Assigned to the owner", { status: "in_progress", ownerAssigned: true, updatedAt: "2026-11-05T00:00:00.000Z" });
    const agentWork = await issue(w, "Agent work", { status: "in_progress", updatedAt: "2026-11-02T00:00:00.000Z" });
    const middle = await issue(w, "Middle blocked", { status: "blocked", updatedAt: "2026-11-10T00:00:00.000Z" });
    const read: string[] = [];
    setCards(w, async (id) => {
      read.push(id);
      return [];
    });
    await readOwnerCards(w.env, A, new Date(0), { scope: "waiting", order: "asc", budgetMs: 60_000, callMs: 5_000, ownerUserId: OWNER });
    expect(read).toEqual([oldest.id, mine.id, middle.id, newest.id]);
    expect(read).not.toContain(agentWork.id);

    // The digest's own options are unchanged: every open issue, newest first.
    read.length = 0;
    await readOwnerCards(w.env, A, new Date(0));
    expect(read).toEqual([newest.id, middle.id, mine.id, agentWork.id, oldest.id]);

    // A budget cut: each read moves the clock on by 10 s and the budget is 25 s, so the first three get read.
    read.length = 0;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(NOW));
    setCards(w, async (id) => {
      read.push(id);
      vi.setSystemTime(new Date(Date.now() + 10_000));
      return [];
    });
    const cut = await readOwnerCards(w.env, A, new Date(0), { scope: "waiting", order: "asc", budgetMs: 25_000, callMs: 5_000, ownerUserId: OWNER });
    expect(read).toEqual([oldest.id, mine.id, middle.id]);
    expect(cut.unread).toMatch(/1 of 4 open tasks/);
  });

  it("starts one refresh at a time, none while the index is fresh, and reports cardsAsOf and cardsRefreshing", async () => {
    const w = await make();
    const waiting = await issue(w, "Review round", { status: "in_review" });
    let calls = 0;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let gateNow = gate;
    setCards(w, async () => {
      calls += 1;
      await gateNow;
      return [{ id: "c1", kind: "request_confirmation", status: "pending", title: "Accept", payload: {}, createdAt: "2026-11-20T00:00:00.000Z" }];
    });

    const [first, second] = await Promise.all([queue(w), queue(w)]);
    expect(first).toMatchObject({ cardsAsOf: null, cardsRefreshing: true });
    expect(second.cardsRefreshing).toBe(true);
    for (let i = 0; i < 100 && calls === 0; i += 1) await new Promise((r) => setTimeout(r, 10));
    expect(calls).toBe(1);
    release();
    await settle(w);
    expect(cardsRefreshing(A)).toBe(false);
    expect(calls).toBe(1);

    clearDecideCache();
    const fresh = await queue(w);
    expect(fresh).toMatchObject({ cardsAsOf: NOW, cardsRefreshing: false });
    expect(fresh.items.map((i) => i.ref.id)).toEqual(["c1"]);
    expect(calls).toBe(1);

    // Older than 2 minutes: the next call starts a refresh and still answers at once with the old list.
    (w.clock as unknown as { set: (iso: string) => void }).set(new Date(Date.parse(NOW) + INDEX_STALE_MS + 1_000).toISOString());
    clearDecideCache();
    gateNow = new Promise<void>((r) => {
      release = r;
    });
    const stale = await queue(w);
    expect(stale).toMatchObject({ cardsAsOf: NOW, cardsRefreshing: true });
    release();
    await settle(w);
    expect(calls).toBe(2);
    void waiting;
  });

  it("keeps the built queue 60 s per company: no host reads inside it, a rebuild after the cache is cleared or expires", async () => {
    const w = await make();
    const i1 = await issue(w, "Slimwerk deploy");
    await ask(w, i1.id, { question: "Ship?", kind: "decision", options: ["Yes", "No"] });
    fixedCards(w, {});
    await refreshOwnerCards(w.env, A);

    const first = await queue(w);
    let approvalReads = 0;
    const realList = (w.ctx.approvals as unknown as { list: (o: unknown) => Promise<unknown[]> }).list;
    (w.ctx.approvals as unknown as { list: unknown }).list = (o: unknown) => {
      approvalReads += 1;
      return realList(o);
    };
    const dbQuery = vi.spyOn(w.ctx.db, "query");
    const stateGet = vi.spyOn(w.ctx.state, "get");
    const second = await queue(w);
    expect(second).toEqual(first);
    expect(approvalReads).toBe(0);
    expect(dbQuery.mock.calls.filter((c) => !/ROLE|roles/i.test(String(c[0])))).toHaveLength(0);
    expect(stateGet.mock.calls.filter((c) => String((c[0] as { stateKey: string }).stateKey).startsWith("decide-cards:"))).toHaveLength(0);

    clearDecideCache(A);
    await queue(w);
    expect(approvalReads).toBe(1);

    (w.clock as unknown as { set: (iso: string) => void }).set(new Date(Date.parse(NOW) + 61_000).toISOString());
    await queue(w);
    expect(approvalReads).toBe(2);
  });

  it("reads the waiting scope oldest first through refreshOwnerCards, and a budget cut stores the oldest cards", async () => {
    const w = await make();
    const newest = await issue(w, "Newest blocked", { status: "blocked", updatedAt: "2026-11-27T00:00:00.000Z" });
    const oldest = await issue(w, "Oldest in review", { status: "in_review", updatedAt: "2026-11-01T00:00:00.000Z" });
    const mine = await issue(w, "Assigned to the owner", { status: "in_progress", ownerAssigned: true, updatedAt: "2026-11-05T00:00:00.000Z" });
    const agentWork = await issue(w, "Agent work", { status: "in_progress", updatedAt: "2026-11-02T00:00:00.000Z" });
    const middle = await issue(w, "Middle blocked", { status: "blocked", updatedAt: "2026-11-10T00:00:00.000Z" });
    const read: string[] = [];
    const cardFor = (id: string) => ({ id: `card-${id}`, kind: "request_confirmation", status: "pending", title: "Accept", payload: {}, createdAt: "2026-11-20T00:00:00.000Z" });
    setCards(w, async (id) => {
      read.push(id);
      return [cardFor(id)];
    });
    const full = await refreshOwnerCards(w.env, A);
    expect(read).toEqual([oldest.id, mine.id, middle.id, newest.id]);
    expect(read).not.toContain(agentWork.id);
    expect(full.pending.map((c) => c.issueId)).toEqual(read);
    expect((await readCardIndex(w.env, A))!.pending).toHaveLength(4);

    // The 60 s budget: each read moves the clock on by 25 s, so the first three get read and the newest is dropped.
    read.length = 0;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(NOW));
    setCards(w, async (id) => {
      read.push(id);
      vi.setSystemTime(new Date(Date.now() + 25_000));
      return [cardFor(id)];
    });
    const cut = await refreshOwnerCards(w.env, A);
    expect(read).toEqual([oldest.id, mine.id, middle.id]);
    expect(cut.pending.map((c) => c.issueId)).toEqual([oldest.id, mine.id, middle.id]);
    expect(cut.unread).toMatch(/1 of 4 open tasks/);
    expect((await readCardIndex(w.env, A))!.pending.map((c) => c.issueId)).toEqual([oldest.id, mine.id, middle.id]);
  });

  it("the digest still reads every open issue, newest first, including agent work", async () => {
    const w = await make();
    const a = await issue(w, "Agent work", { status: "in_progress", updatedAt: "2026-11-02T00:00:00.000Z" });
    const b = await issue(w, "In review", { status: "in_review", updatedAt: "2026-11-20T00:00:00.000Z" });
    const c = await issue(w, "Mine", { status: "todo", ownerAssigned: true, updatedAt: "2026-11-10T00:00:00.000Z" });
    const read: string[] = [];
    setCards(w, async (id) => {
      read.push(id);
      return [];
    });
    await buildOwnerDigest(w.env, A);
    expect(read).toEqual([b.id, c.id, a.id]);
  });

  it("refuses at once when the owner lookup hangs, inside the deadline", async () => {
    const w = await make();
    // The database object is shared by every world in this file: put the real query back afterwards.
    const db = w.ctx.db as unknown as { query: (sql: string, params?: unknown[]) => Promise<unknown> };
    const realQuery = db.query;
    db.query = (sql: string, params?: unknown[]) => (/roles/i.test(sql) ? new Promise(() => undefined) : realQuery.call(db, sql, params));
    try {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      const call = queue(w).then((v) => ({ v }), (error: Error) => ({ error }));
      const run = await runFake(call, 20_000);
      expect(run.settled).toBe(true);
      expect(run.elapsed).toBeLessThan(20_000);
      expect(run.value).toHaveProperty("error");
    } finally {
      db.query = realQuery;
    }
  });

  it("shows the cards on the second call after a first open with no index, within the 60 s cache", async () => {
    const w = await make();
    await issue(w, "Review round", { status: "in_review" });
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    setCards(w, async () => {
      await gate;
      return [{ id: "c1", kind: "request_confirmation", status: "pending", title: "Accept", payload: {}, createdAt: "2026-11-20T00:00:00.000Z" }];
    });
    const first = await queue(w);
    expect(first).toMatchObject({ cardsAsOf: null, cardsRefreshing: true });
    expect(first.items).toHaveLength(0);
    release();
    await settle(w);
    const second = await queue(w);
    expect(second.cardsAsOf).toBe(NOW);
    expect(second.items.map((i) => i.ref.id)).toEqual(["c1"]);
  });

  it("keeps the last good card list when a refresh reads nothing at all", async () => {
    const w = await make();
    await issue(w, "Review round", { status: "in_review" });
    setCards(w, async () => [{ id: "c1", kind: "request_confirmation", status: "pending", title: "Accept", payload: {}, createdAt: "2026-11-20T00:00:00.000Z" }]);
    await refreshOwnerCards(w.env, A);
    setCards(w, async () => {
      throw new Error("Plugin is missing required capability 'issue.interactions.read'");
    });
    const second = await refreshOwnerCards(w.env, A);
    expect(second.unread).toMatch(/not allowed to read/);
    expect(second.pending.map((c) => c.id)).toEqual(["c1"]);
    expect((await readCardIndex(w.env, A))!.pending.map((c) => c.id)).toEqual(["c1"]);
  });

  it("treats an index with a corrupt time as stale and refreshes it", async () => {
    const w = await make();
    await w.ctx.state.set({ scopeKind: "company", scopeId: A, namespace: "cockpit", stateKey: `decide-cards:${A}` }, { at: "not a date", pending: [], unread: null });
    let calls = 0;
    await issue(w, "Review round", { status: "in_review" });
    setCards(w, async () => {
      calls += 1;
      return [];
    });
    await queue(w);
    await settle(w);
    expect(calls).toBe(1);
  });
});
