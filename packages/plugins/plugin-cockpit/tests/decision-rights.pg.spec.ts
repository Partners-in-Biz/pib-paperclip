/**
 * Decision rights through the real `ask-owner` tool: a question that is not a
 * hard stop goes to the seat that decides its class at the moment it is
 * raised, and nothing reaches the owner.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listOpenAsks } from "../src/asks.js";
import { ORIGIN } from "../src/constants.js";
import { decisionOriginId, ROUTED_REPAIR_KIND } from "../src/decision-rights.js";
import { listRepairs } from "../src/repairs.js";
import { saveTeam } from "../src/roles.js";
import { COMPANY, embeddedAvailable } from "./helpers/pg.js";
import { startWorlds, type Hybrid } from "./helpers/hybrid.js";

const available = await embeddedAvailable();
const d = available ? describe : describe.skip;

const A = COMPANY;
const DEV = "aaaaaaaa-0000-4000-8000-0000000000d1";
const MARCUS = "aaaaaaaa-0000-4000-8000-0000000000b1";
const PIB = "aaaaaaaa-0000-4000-8000-0000000000b2";
const RHEA = "aaaaaaaa-0000-4000-8000-0000000000b3";
const GONE = "aaaaaaaa-0000-4000-8000-0000000000b4";
const RIGHTS = { ownProducts: ["Velox", "Lumen"], seats: { release: MARCUS, social: RHEA, storeListing: GONE, other: PIB } };

type ToolResult = { error?: string; data: { askId: string | null; status: string; handedToOwner: boolean; next: string; routedTo?: { agentId: string; name: string; decisionClass: string; decisionIssue: string }; hardStop?: string | null } };

d("decision rights: routing at the moment the agent asks (Postgres)", () => {
  let worlds: Awaited<ReturnType<typeof startWorlds>>;
  beforeAll(async () => {
    worlds = await startWorlds();
  }, 120_000);
  afterAll(async () => {
    await worlds?.stop();
  });

  async function make(config: Record<string, unknown> = { decisionRights: RIGHTS }) {
    const w = await worlds.make({
      savedConfigs: { [A]: { healthIssue: true, ...config } },
      prefixes: { [A]: "PAR" },
      agents: [
        { id: DEV, companyId: A, name: "Dev", status: "active", role: "engineer" },
        { id: MARCUS, companyId: A, name: "Marcus", status: "active", role: "cto" },
        { id: PIB, companyId: A, name: "PiB", status: "active", role: "ceo" },
        { id: RHEA, companyId: A, name: "Rhea", status: "active", role: "cmo" },
        { id: GONE, companyId: A, name: "Steve", status: "terminated", role: "general" },
      ],
    });
    await saveTeam(w.env, A, { operatorAgentId: PIB }, "user-owner");
    return w;
  }

  let n = 0;
  async function issue(w: Hybrid, assignee = DEV) {
    n += 1;
    const id = `dddddddd-0000-4000-8000-${String(n).padStart(12, "0")}`;
    const row = { id, companyId: A, identifier: `PAR-${500 + n}`, title: "Ship the thing", description: "", status: "in_progress", assigneeAgentId: assignee, priority: "high" };
    w.issues.set(id, row);
    await w.client.query(`INSERT INTO public.issues (id, company_id, identifier, title, status, assignee_agent_id) VALUES ($1, $2, $3, $4, 'in_progress', $5)`, [id, A, row.identifier, row.title, assignee]);
    return row;
  }

  const ask = async (w: Hybrid, issueId: string, question: string, extra: Record<string, unknown> = {}, agentId = DEV) =>
    (await w.tools.get("ask-owner")!(
      { issueId, question, why: "The work waits on it.", kind: "decision", options: ["Yes", "No"], links: [{ label: "The issue", href: "/PAR/issues/PAR-1" }], ...extra },
      { agentId, runId: "run-1", companyId: A, projectId: "" },
    )) as ToolResult;

  const decisionIssues = (w: Hybrid) => [...w.issues.values()].filter((i) => i.originKind === ORIGIN.decision);

  it("a release of our own product goes to its seat: a Decision issue for Marcus that blocks the asking issue, nothing for the owner", async () => {
    const w = await make();
    const iss = await issue(w);
    const result = await ask(w, iss.id, "Promote Velox development to main? Vera passed it and CI is green.");
    expect(result.error).toBeUndefined();
    expect(result.data).toMatchObject({ status: "routed", askId: null, handedToOwner: false, hardStop: null, routedTo: { agentId: MARCUS, name: "Marcus", decisionClass: "release" } });
    expect(result.data.next).toContain("Marcus decides it");
    expect(result.data.next).toContain("Do not ask the owner about this");

    // One Decision issue, for the seat, under the asking issue.
    const [decision] = decisionIssues(w);
    expect(decisionIssues(w)).toHaveLength(1);
    expect(decision).toMatchObject({ assigneeAgentId: MARCUS, parentId: iss.id, originId: decisionOriginId(iss.id), status: "todo", priority: "high" });
    expect(decision!.title).toBe("Decision (release of our own products): Promote Velox development to main? Vera passed it and CI is green.");
    expect(decision!.description).toContain("You decide this class; it does not go to the owner.");
    expect(decision!.description).toContain("1. **Yes** (recommended)");
    expect(decision!.description).toContain(`Comment on ${iss.identifier} with the first line \`DECISION (release of our own products): yes|no, <one reason>\``);
    expect(result.data.routedTo!.decisionIssue).toBe(decision!.identifier);
    // The seat is woken; the asking issue waits on the Decision issue and stays with its agent.
    expect(w.wakeups).toContain(decision!.id);
    expect(w.issues.get(iss.id)).toMatchObject({ status: "blocked", blockedByIssueIds: [decision!.id], assigneeAgentId: DEV });
    expect(w.issues.get(iss.id)!.assigneeUserId ?? null).toBeNull();
    // The asking issue says where the question went.
    expect(w.comments.some((c) => c.issueId === iss.id && c.body.startsWith("**Decision needed: with Marcus**"))).toBe(true);
    // Nothing is stored for the owner, and the routing is on the ledger.
    expect(await listOpenAsks(w.env, A)).toHaveLength(0);
    const ledger = await listRepairs(w.env.ctx, A, { kind: ROUTED_REPAIR_KIND });
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ targetId: iss.id, action: "route_to_seat", outcome: "routed", actor: `agent:${DEV}` });
    expect(ledger[0]!.detail).toContain("release -> Marcus");
  });

  it("a question with no class goes to the seat for anything else", async () => {
    const w = await make();
    const iss = await issue(w);
    const result = await ask(w, iss.id, "Which of the two approaches should I take?");
    expect(result.data).toMatchObject({ status: "routed", routedTo: { agentId: PIB, decisionClass: "other" } });
    expect(await listOpenAsks(w.env, A)).toHaveLength(0);
  });

  it("a hard stop goes to the owner as before, by its words or named by the asker", async () => {
    const w = await make();
    const first = await issue(w);
    const money = await ask(w, first.id, "Send quote Q-HUN-001 to Hunt and Gun, R 6,860.00?", { links: [{ label: "Quote", href: "/PAR/billing" }] });
    expect(money.data).toMatchObject({ status: "asked", handedToOwner: true, hardStop: "money" });
    expect(w.issues.get(first.id)).toMatchObject({ status: "in_review", assigneeUserId: "user-owner" });
    const second = await issue(w);
    const named = await ask(w, second.id, "Go ahead with option A?", { hardStop: "client-production" });
    expect(named.data).toMatchObject({ status: "asked", handedToOwner: true, hardStop: "client-production" });
    expect(decisionIssues(w)).toHaveLength(0);
    expect(await listOpenAsks(w.env, A)).toHaveLength(2);
  });

  it("a decider who cannot decide its own class passes it to the last seat; the last seat's own question goes to the owner", async () => {
    const w = await make();
    const mine = await issue(w, MARCUS);
    const passed = await ask(w, mine.id, "Promote Lumen development to main?", {}, MARCUS);
    expect(passed.data).toMatchObject({ status: "routed", routedTo: { agentId: PIB, decisionClass: "release" } });
    expect(decisionIssues(w)[0]!.description).toContain("could not decide it and passed it to you");

    const pibs = await issue(w, PIB);
    const up = await ask(w, pibs.id, "Which approach should we take for the pilot?", {}, PIB);
    expect(up.data).toMatchObject({ status: "asked", handedToOwner: true, hardStop: null });
  });

  it("asking again on the same issue updates the one open Decision issue", async () => {
    const w = await make();
    const iss = await issue(w);
    await ask(w, iss.id, "Promote Velox development to main?");
    const again = await ask(w, iss.id, "Promote Velox development to main today or on Friday?", { options: ["Today", "Friday"] });
    expect(again.data.status).toBe("routed");
    const decisions = decisionIssues(w);
    expect(decisions).toHaveLength(1);
    expect(w.comments.some((c) => c.issueId === decisions[0]!.id && c.body.startsWith("**The question changed.**") && c.body.includes("today or on Friday"))).toBe(true);
    const ledger = await listRepairs(w.env.ctx, A, { kind: ROUTED_REPAIR_KIND });
    expect(ledger.map((r) => r.outcome).sort()).toEqual(["routed", "updated"]);
  });

  it("a seat whose agent is gone never swallows a question: it goes to the owner", async () => {
    const w = await make();
    const iss = await issue(w);
    const result = await ask(w, iss.id, "New subtitle and keywords for the Velox App Store listing: use them?");
    expect(result.data).toMatchObject({ status: "asked", handedToOwner: true });
    expect(decisionIssues(w)).toHaveLength(0);
  });

  it("a company with no seats keeps the old behaviour: every question goes to the owner", async () => {
    const w = await make({});
    const iss = await issue(w);
    const result = await ask(w, iss.id, "Promote Velox development to main?");
    expect(result.data).toMatchObject({ status: "asked", handedToOwner: true });
    expect(decisionIssues(w)).toHaveLength(0);
  });

  it("refuses a hard stop that is not one of the six", async () => {
    const w = await make();
    const iss = await issue(w);
    const result = await ask(w, iss.id, "Go ahead?", { hardStop: "urgent" });
    expect(result.error).toContain("hardStop must be one of client-production, money, logins, legal, store-release, data-delete");
  });
});
