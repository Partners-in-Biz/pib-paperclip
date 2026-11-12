/**
 * The owner's one daily digest, end to end: asks, approval cards and tasks
 * assigned to the owner become ONE issue a day, each task once, with what
 * waits behind it; the sweep posts it from 16:00 SAST and never twice.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ORIGIN } from "../src/constants.js";
import { buildOwnerDigest, ownerDigestTick, postOwnerDigest, readOwnerCards } from "../src/digest.js";
import { saveTeam } from "../src/roles.js";
import { COMPANY, embeddedAvailable } from "./helpers/pg.js";
import { startWorlds, type Hybrid } from "./helpers/hybrid.js";

const available = await embeddedAvailable();
const d = available ? describe : describe.skip;

const A = COMPANY;
const OP = "aaaaaaaa-0000-4000-8000-0000000000a1";
const DEV = "aaaaaaaa-0000-4000-8000-0000000000a2";
const OWNER = "user-owner";
/** 16:05 SAST on Wed 11 Nov 2026. */
const AT_1605 = "2026-11-11T14:05:00.000Z";
const BASE = "https://paperclip.partnersinbiz.online/PAR/issues/";

d("the owner's daily digest (Postgres)", () => {
  let worlds: Awaited<ReturnType<typeof startWorlds>>;
  beforeAll(async () => {
    worlds = await startWorlds();
  }, 120_000);
  afterAll(async () => {
    await worlds?.stop();
  });

  async function make(now = AT_1605, config: Record<string, unknown> = {}) {
    const w = await worlds.make(
      {
        savedConfigs: { [A]: { healthIssue: true, ...config } },
        prefixes: { [A]: "PAR" },
        agents: [
          { id: OP, companyId: A, name: "Olive", status: "active", role: "general" },
          { id: DEV, companyId: A, name: "Dev", status: "active", role: "engineer" },
        ],
      },
      now,
    );
    await saveTeam(w.env, A, { operatorAgentId: OP }, OWNER);
    return w;
  }

  let n = 0;
  async function issue(w: Hybrid, title: string, extra: { status?: string; ownerAssigned?: boolean; createdAt?: string; originKind?: string } = {}) {
    n += 1;
    const id = `dddddddd-0000-4000-8000-${String(n).padStart(12, "0")}`;
    const identifier = `PAR-${700 + n}`;
    const status = extra.status ?? "in_progress";
    const at = extra.createdAt ?? "2026-11-10T08:00:00.000Z";
    w.issues.set(id, { id, companyId: A, identifier, title, description: "", status, assigneeAgentId: extra.ownerAssigned ? null : DEV, assigneeUserId: extra.ownerAssigned ? OWNER : null, originKind: extra.originKind });
    await w.client.query(
      `INSERT INTO public.issues (id, company_id, identifier, title, status, assignee_agent_id, assignee_user_id, origin_kind, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)`,
      [id, A, identifier, title, status, extra.ownerAssigned ? null : DEV, extra.ownerAssigned ? OWNER : null, extra.originKind ?? null, at],
    );
    return { id, identifier };
  }

  async function blocks(w: Hybrid, blocker: string, blocked: string) {
    await w.client.query(`INSERT INTO public.issue_relations (company_id, issue_id, related_issue_id, type) VALUES ($1, $2, $3, 'blocks')`, [A, blocker, blocked]);
  }

  function cards(w: Hybrid, byIssue: Record<string, Array<Record<string, unknown>>>, fail?: string) {
    (w.ctx.issues as unknown as { listInteractions: (issueId: string, companyId: string) => Promise<unknown[]> }).listInteractions = async (issueId) => {
      if (fail) throw new Error(fail);
      return byIssue[issueId] ?? [];
    };
  }

  const askOwner = async (w: Hybrid, issueId: string, body: Record<string, unknown>) => {
    const result = (await w.tools.get("ask-owner")!({ issueId, why: "Work waits on it.", ...body }, { agentId: DEV, runId: "run-1", companyId: A, projectId: "" })) as { error?: string; data: { askId: string } };
    if (result.error) throw new Error(result.error);
    return result.data.askId;
  };

  it("lists every open item once, grouped by place, with what waits behind it and the day's numbers", async () => {
    const w = await make();
    // 1. A question an agent asked (a login only the owner has): a hard stop.
    const firebase = await issue(w, "Slimwerk deploy");
    await askOwner(w, firebase.id, { question: "Run firebase login --reauth on the box so the Slimwerk deploys work?", kind: "grant", steps: ["Run firebase login --reauth"], links: [{ label: "Firebase console", href: "https://console.firebase.google.com" }] });
    // 2. A host approval card on a task that is not assigned to the owner, raised today.
    const drive = await issue(w, "SA Gun Auctions assets", { status: "in_review" });
    // 3. An old host card on a task that IS assigned to the owner: one line, the card's words.
    const store = await issue(w, "Attribution batch 1", { status: "blocked", ownerAssigned: true, createdAt: "2026-09-28T08:00:00.000Z" });
    // 4. A plain task assigned to the owner that holds up two others.
    const logo = await issue(w, "Dolphin Coast Deals: pick logo concept A, B or C", { status: "in_review", ownerAssigned: true });
    const waitingA = await issue(w, "Build the site header");
    const waitingB = await issue(w, "Print the banner");
    await blocks(w, logo.id, waitingA.id);
    await blocks(w, waitingA.id, waitingB.id);
    // A card for an agent, an answered card and the old hand-written digest are not the owner's work.
    const agentCard = await issue(w, "Review round");
    const oldDigest = await issue(w, "16:00 digest 2026-11-10 (dual-run)", { status: "todo", ownerAssigned: true });
    cards(w, {
      [drive.id]: [{ id: "card-1", kind: "request_confirmation", status: "pending", title: null, payload: { prompt: "Share the Drive folder \"SA Gun Auctions (Werner)\" with the pib-drive service account as Editor, then accept." }, createdAt: "2026-11-11T09:00:00.000Z" }],
      [store.id]: [
        { id: "card-2", kind: "ask_user_questions", status: "pending", title: "Batch-1 attribution: two values needed", payload: { questions: [{ prompt: "Paste the App Store Connect provider token." }] }, createdAt: "2026-09-28T08:00:00.000Z" },
        { id: "card-3", kind: "request_confirmation", status: "accepted", title: "Old", payload: {}, createdAt: "2026-09-20T08:00:00.000Z" },
      ],
      [agentCard.id]: [{ id: "card-4", kind: "request_confirmation", status: "pending", addresseeAgentId: OP, title: "For an agent", payload: {}, createdAt: "2026-11-11T09:00:00.000Z" }],
    });

    const digest = (await buildOwnerDigest(w.env, A))!;
    expect(digest.title).toBe("16:00 digest 2026-11-11");
    expect(digest.items.map((i) => i.identifier).sort()).toEqual([drive.identifier, firebase.identifier, logo.identifier, store.identifier].sort());
    expect(digest.items.some((i) => i.identifier === oldDigest.identifier || i.identifier === agentCard.identifier)).toBe(false);

    const lines = digest.body.split("\n");
    // The header: how many, the new asks today (one ask and one card raised today), the oldest open one.
    expect(lines[0]).toBe(`4 items wait on you, in 4 places. New asks today: 2 (first reading). Oldest open: [${store.identifier}](${BASE}${store.identifier}), 44 days.`);
    // By place, in the owner's order.
    expect(lines.filter((l) => l.startsWith("**"))).toEqual(["**Quick clicks** (1)", "**At the Mac** (1)", "**Store consoles** (1)", "**Decisions** (1)"]);
    expect(digest.body).toContain(`- [${drive.identifier}](${BASE}${drive.identifier}) Share the Drive folder "SA Gun Auctions (Werner)" with the pib-drive service account as Editor, then accept.`);
    expect(digest.body).toContain(`- [${firebase.identifier}](${BASE}${firebase.identifier}) Run firebase login --reauth on the box so the Slimwerk deploys work?`);
    // The owner's task with a card shows once, in the card's words.
    expect(digest.body).toContain(`- [${store.identifier}](${BASE}${store.identifier}) Batch-1 attribution: two values needed. Waited 44 days.`);
    expect(digest.body.match(new RegExp(`^- \\[${store.identifier}\\]`, "gm"))).toHaveLength(1);
    // What waits behind it: the header and the banner, through the chain.
    expect(digest.body).toContain(`- [${logo.identifier}](${BASE}${logo.identifier}) Dolphin Coast Deals: pick logo concept A, B or C. Holds 2.`);
    expect(digest.today).toEqual({ date: "2026-11-11", newAsks: 2, open: 4, oldestDays: 44 });
    expect(digest.stats.unread).toEqual([]);
  });

  it("posts one issue for the owner, once a day, and closes yesterday's", async () => {
    const w = await make();
    const task = await issue(w, "Pick the logo", { status: "in_review", ownerAssigned: true });
    cards(w, {});

    const first = await postOwnerDigest(w.env, A);
    expect(first).toMatchObject({ posted: true, items: 1, date: "2026-11-11" });
    const posted = [...w.issues.values()].filter((i) => i.originKind === ORIGIN.digest);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ title: "16:00 digest 2026-11-11", assigneeUserId: OWNER, status: "todo", originId: `cockpit:digest:${A}:2026-11-11` });
    expect(posted[0]!.description).toContain(task.identifier);

    // The same day again: nothing.
    expect(await postOwnerDigest(w.env, A)).toMatchObject({ posted: false, reason: "already-posted" });
    expect([...w.issues.values()].filter((i) => i.originKind === ORIGIN.digest)).toHaveLength(1);

    // The next day: a new one, yesterday's is closed, and yesterday's numbers show as the trend.
    w.clock.set("2026-11-12T14:00:00.000Z");
    const second = await postOwnerDigest(w.env, A);
    expect(second).toMatchObject({ posted: true, date: "2026-11-12" });
    const all = [...w.issues.values()].filter((i) => i.originKind === ORIGIN.digest);
    expect(all.map((i) => [i.title, i.status])).toEqual([
      ["16:00 digest 2026-11-11", "done"],
      ["16:00 digest 2026-11-12", "todo"],
    ]);
    expect(all[1]!.description).toContain("New asks today: 0 (11-11: 0).");
  });

  it("never posts twice in a day, even when the stored date is lost: the issue itself is the second guard", async () => {
    const w = await make();
    await issue(w, "Pick the logo", { status: "in_review", ownerAssigned: true });
    cards(w, {});
    expect((await postOwnerDigest(w.env, A)).posted).toBe(true);
    w.state.clear();
    expect(await postOwnerDigest(w.env, A)).toMatchObject({ posted: false, reason: "already-posted" });
    expect([...w.issues.values()].filter((i) => i.originKind === ORIGIN.digest)).toHaveLength(1);
  });

  it("the sweep posts from 16:00 SAST, catches up a missed one until the evening, and posts nothing when nothing waits", async () => {
    const early = await make("2026-11-11T13:45:00.000Z"); // 15:45
    await issue(early, "Pick the logo", { status: "in_review", ownerAssigned: true });
    cards(early, {});
    expect(await ownerDigestTick(early.env)).toEqual({ posted: 0, skipped: 0, failed: 0 });
    early.clock.set("2026-11-11T14:00:00.000Z"); // 16:00
    expect(await ownerDigestTick(early.env)).toEqual({ posted: 1, skipped: 0, failed: 0 });
    early.clock.set("2026-11-11T14:15:00.000Z");
    expect(await ownerDigestTick(early.env)).toEqual({ posted: 0, skipped: 0, failed: 0 });

    const late = await make("2026-11-11T19:30:00.000Z"); // 21:30, the 16:00 sweep was missed
    await issue(late, "Pick the logo", { status: "in_review", ownerAssigned: true });
    cards(late, {});
    expect((await ownerDigestTick(late.env)).posted).toBe(1);

    const night = await make("2026-11-11T20:15:00.000Z"); // 22:15: too late, tomorrow's carries it
    await issue(night, "Pick the logo", { status: "in_review", ownerAssigned: true });
    cards(night, {});
    expect((await ownerDigestTick(night.env)).posted).toBe(0);

    const empty = await make();
    cards(empty, {});
    expect(await ownerDigestTick(empty.env)).toEqual({ posted: 0, skipped: 1, failed: 0 });
    expect([...empty.issues.values()].filter((i) => i.originKind === ORIGIN.digest)).toHaveLength(0);
    // Not built again every 15 minutes for the rest of the day.
    expect(await ownerDigestTick(empty.env)).toEqual({ posted: 0, skipped: 0, failed: 0 });

    const off = await make(AT_1605, { ownerDigest: { enabled: false } });
    await issue(off, "Pick the logo", { status: "in_review", ownerAssigned: true });
    cards(off, {});
    expect((await ownerDigestTick(off.env)).posted).toBe(0);
  });

  it("says so when the approval cards cannot be read, instead of showing none", async () => {
    const w = await make();
    await issue(w, "Pick the logo", { status: "in_review", ownerAssigned: true });
    cards(w, {}, "Plugin is missing required capability 'issue.interactions.read'");
    const read = await readOwnerCards(w.env, A, new Date(AT_1605));
    expect(read).toEqual({ pending: [], raisedToday: 0, unread: "approval cards (the Cockpit is not allowed to read them yet)" });
    const digest = (await buildOwnerDigest(w.env, A))!;
    expect(digest.body).toContain("Not read this time: approval cards (the Cockpit is not allowed to read them yet).");
    expect(digest.items).toHaveLength(1);
  });

  it("an ask that will answer itself says when, on its line", async () => {
    const w = await make("2026-11-11T08:00:00.000Z");
    const layout = await issue(w, "Landing page");
    await askOwner(w, layout.id, { question: "Which layout for the landing page?", kind: "decision", options: ["Layout A", "Layout B"], links: [{ label: "The issue", href: `/PAR/issues/${layout.identifier}` }] });
    cards(w, {});
    w.clock.set(AT_1605);
    const digest = (await buildOwnerDigest(w.env, A))!;
    expect(digest.body).toContain("Which layout for the landing page? Applies by itself Thu 10:00: Layout A.");
  });
});
