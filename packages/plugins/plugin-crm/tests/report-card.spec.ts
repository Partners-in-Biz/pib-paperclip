import { describe, expect, it } from "vitest";
import { runClientCareJob } from "../src/care-jobs.js";
import { openReportCards } from "../src/report-batch.js";
import { currentPeriod, periodLabel } from "../src/report-render.js";
import { answerSend, bootCare, careSeed, CO, contact, decide, issuesWith, sentMail, tool, type Booted, type Harness } from "./helpers/care.js";

const PERIOD = currentPeriod(new Date());
const SUMMARY = "A good month: more people found you on Google and every support request was answered the same day.";
const NAMES = ["Acme Plumbing", "Pat Plumber", "Lee Locksmith"];

function profile(id: string, kind: "company" | "contact", ref: string) {
  return { id, company_id: CO, client_kind: kind, client_ref: ref, brand_voice: null, audience: null, services: ["seo"], website: null, booking_link: null, banned_words: [], tone_notes: null, human_owned: [], updated_by: null, updated_at: "2026-09-01T00:00:00Z", services_other: [], services_normalized_at: "2026-09-01T00:00:00Z" };
}

/** Three clients, each with a built report and a written summary, each sent for approval. */
async function threeAsked(): Promise<Booted & { approvals: Array<Record<string, any>> }> {
  const store = careSeed({
    client_profiles: [profile("pr1", "company", "acme"), profile("pr2", "contact", "pat"), profile("pr3", "contact", "lee")],
    contacts: [contact("pat", "Pat Plumber", { emails: ["pat@solo.test"], lifecycle: "customer" }), contact("lee", "Lee Locksmith", { emails: ["lee@solo.test"], lifecycle: "customer" })] as never,
  });
  store.contacts = [...careSeed().contacts!, ...store.contacts!];
  const booted = await bootCare({ store, routes: [] });
  for (const client of ["company:acme", "contact:pat", "contact:lee"]) {
    await tool(booted.harness, "build-client-report", { client, period: PERIOD });
    await tool(booted.harness, "set-report-narrative", { client, period: PERIOD, summary: SUMMARY });
    const sent = await tool<Record<string, any>>(booted.harness, "send-client-report", { client, period: PERIOD });
    expect(sent.approvalIssueId).toBeNull();
  }
  return { ...booted, approvals: booted.store.care_approvals! };
}

/** Every comment the plugin writes, by issue (reading comments is not a plugin capability). */
function spyComments(harness: Harness): string[] {
  const written: string[] = [];
  const original = harness.ctx.issues.createComment.bind(harness.ctx.issues);
  harness.ctx.issues.createComment = (async (issueId: string, body: string, ...rest: unknown[]) => {
    written.push(body);
    return (original as (...args: unknown[]) => Promise<unknown>)(issueId, body, ...rest);
  }) as never;
  return written;
}

/** The person ticks some clients and answers the card: the host stores the status and the ticked option ids on the interaction. */
async function answer(harness: Harness, issueId: string, ticked: string[], action: "accept" | "reject" = "accept") {
  const [interaction] = await harness.ctx.issues.listInteractions(issueId, CO);
  Object.assign(interaction!, { status: action === "accept" ? "accepted" : "rejected", result: { version: 1, outcome: action === "accept" ? "accepted" : "rejected", selectedOptionIds: ticked } });
}

describe("one approval card for the month's client reports", () => {
  it("opens one issue and one checkbox card for all clients, and no per-client Approve issue", async () => {
    const { harness, approvals } = await threeAsked();
    await openReportCards(harness.ctx, CO);
    const cards = await issuesWith(harness, "crm:report-batch:");
    expect(cards).toHaveLength(1);
    expect(cards[0]!.title).toBe(`Approve client reports: ${periodLabel(PERIOD)}`);
    expect((await issuesWith(harness, "crm:approval:")).length).toBe(0);
    const interactions = await harness.ctx.issues.listInteractions(cards[0]!.id, CO);
    expect(interactions).toHaveLength(1);
    expect(interactions[0]).toMatchObject({ kind: "request_checkbox_confirmation", status: "pending" });
    expect((interactions[0]!.payload as { options: Array<{ label: string }> }).options.map((o) => o.label).sort()).toEqual([...NAMES].sort());
    expect(approvals.every((a) => a.issue_id === cards[0]!.id)).toBe(true);
  });

  it("a second run does not open a second card or a second interaction", async () => {
    const { harness } = await threeAsked();
    await runClientCareJob(harness.ctx, new Date());
    await runClientCareJob(harness.ctx, new Date());
    await openReportCards(harness.ctx, CO);
    const cards = await issuesWith(harness, "crm:report-batch:");
    expect(cards).toHaveLength(1);
    expect(await harness.ctx.issues.listInteractions(cards[0]!.id, CO)).toHaveLength(1);
  });

  it("approving 2 of 3 sends 2 and holds 1, naming the held client in a comment", async () => {
    const { harness, store, emit, approvals } = await threeAsked();
    const written = spyComments(harness);
    await runClientCareJob(harness.ctx, new Date());
    const [card] = await issuesWith(harness, "crm:report-batch:");
    const idOf = (client: string) => approvals.find((a) => a.client_ref === client)!.id as string;
    await answer(harness, card!.id, [idOf("acme"), idOf("lee")]);
    await runClientCareJob(harness.ctx, new Date());
    expect(sentMail(emit).map((m) => m.to[0].email).sort()).toEqual(["ada@acme.co.za", "lee@solo.test"]);
    expect(store.care_approvals!.find((a) => a.client_ref === "pat")).toMatchObject({ status: "refused" });
    const comments = written.join("\n");
    expect(comments).toMatch(/Held, nothing was sent to: Pat Plumber/);
    expect(comments).not.toMatch(/Held[^\n]*Lee Locksmith/);
    expect((await harness.ctx.issues.get(card!.id, CO))!.status).toBe("done");
    // A later run neither sends again nor re-comments.
    await runClientCareJob(harness.ctx, new Date());
    expect(sentMail(emit)).toHaveLength(2);
    await answerSend(harness, sentMail(emit)[0]!.key, "sent");
  });

  it("declining the card holds every client", async () => {
    const { harness, emit } = await threeAsked();
    const written = spyComments(harness);
    await runClientCareJob(harness.ctx, new Date());
    const [card] = await issuesWith(harness, "crm:report-batch:");
    await answer(harness, card!.id, [], "reject");
    await runClientCareJob(harness.ctx, new Date());
    expect(sentMail(emit)).toHaveLength(0);
    const comments = written.join("\n");
    for (const name of NAMES) expect(comments).toContain(name);
  });

  it("an agent closing the card has it reopened; a person marking it done sends every client", async () => {
    const { harness, emit } = await threeAsked();
    await runClientCareJob(harness.ctx, new Date());
    const [card] = await issuesWith(harness, "crm:report-batch:");
    const reopened = await decide(harness, card!.id, "done", "agent");
    expect(reopened.status).toBe("todo");
    expect(sentMail(emit)).toHaveLength(0);
    await decide(harness, card!.id, "done", "user");
    expect(sentMail(emit)).toHaveLength(3);
  });
});
