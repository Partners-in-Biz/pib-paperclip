/**
 * The People and Results tabs: where each person stands in plain words, the
 * order people are listed in, and the numbers per step and version.
 */
import { describe, expect, it } from "vitest";
import { emptyCounts, peopleSummary, peopleView, personState, rate, resultsView, stepNumbers, type PersonRow } from "../src/people.js";
import { unfilledPlaceholders } from "../src/preflight.js";

const NOW = new Date("2026-11-12T12:00:00Z");
const STEPS = [{ position: 1 }, { position: 2 }, { position: 5 }];
const NUMBERS = stepNumbers(STEPS);

function person(over: Partial<PersonRow> = {}): PersonRow {
  return {
    enrollmentId: "e-1", contactId: "ada", name: "Ada Lovelace", email: "ada@acme.test", status: "running", stepPosition: 1, variant: "a",
    nextDueAt: null, enrolledAt: "2026-11-11T05:39:00Z", task: null, sending: false, events: [], ...over,
  };
}
const sent = (stepPosition: number) => ({ type: "sent", stepPosition, count: 1, at: "2026-11-11T06:00:00Z" });

describe("stepNumbers", () => {
  it("numbers positions 1, 2, 3 in order even when they skip, and counts an A and a B once", () => {
    expect([...stepNumbers([{ position: 5 }, { position: 1 }, { position: 2 }, { position: 2 }])]).toEqual([[1, 1], [2, 2], [5, 3]]);
  });
});

describe("personState", () => {
  it("a blocked task holds the person, and names the task", () => {
    const state = personState(person({ task: { id: "i-1", identifier: "PAR-9094", status: "blocked" } }), NUMBERS, NOW);
    expect(state).toMatchObject({ key: "held", label: "Email 1 held", tone: "bad" });
    expect(state.next).toBe("Task PAR-9094 is blocked. Nothing goes out until that is fixed.");
  });

  it("an open task waits for the agent", () => {
    expect(personState(person({ task: { id: "i-1", identifier: "PAR-1", status: "todo" } }), NUMBERS, NOW)).toMatchObject({ key: "waiting-agent", label: "Email 1 waiting for the agent", tone: "warn" });
  });

  it("an email in flight is sending", () => {
    expect(personState(person({ sending: true }), NUMBERS, NOW).key).toBe("sending");
  });

  it("a later step shows the last email sent and the date of the next, numbered as on the screen", () => {
    const state = personState(person({ stepPosition: 5, nextDueAt: "2026-11-19T08:00:00Z", events: [sent(1), sent(2)] }), NUMBERS, NOW);
    expect(state).toMatchObject({ key: "scheduled", label: "Email 2 sent", next: "Email 3 on 19 Nov.", tone: "ok" });
  });

  it("due within minutes, or with no date, is due now", () => {
    expect(personState(person({ nextDueAt: "2026-11-12T12:03:00Z" }), NUMBERS, NOW)).toMatchObject({ key: "due", label: "Enrolled", next: "Email 1 is due now." });
    expect(personState(person(), NUMBERS, NOW).key).toBe("due");
  });

  it("a stopped person says why: opted out before bounced before replied", () => {
    const stopped = (events: PersonRow["events"]) => personState(person({ status: "stopped", events }), NUMBERS, NOW);
    expect(stopped([sent(1), { type: "reply", stepPosition: 1, count: 1, at: null }])).toMatchObject({ key: "replied", label: "Email 1 sent, replied", tone: "ok" });
    expect(stopped([sent(1), { type: "bounce", stepPosition: 1, count: 1, at: null }])).toMatchObject({ key: "bounced", tone: "bad" });
    expect(stopped([sent(1), { type: "reply", stepPosition: 1, count: 1, at: null }, { type: "unsubscribe", stepPosition: 1, count: 1, at: null }]).key).toBe("opted-out");
    expect(stopped([sent(1), { type: "complaint", stepPosition: 1, count: 1, at: null }]).key).toBe("opted-out");
    expect(stopped([])).toMatchObject({ key: "stopped", label: "Stopped before the first email" });
    expect(stopped([sent(1)])).toMatchObject({ key: "stopped", label: "Email 1 sent, then stopped" });
  });

  it("a finished person counts their emails", () => {
    expect(personState(person({ status: "done", events: [sent(1), sent(2), sent(5)] }), NUMBERS, NOW)).toMatchObject({ key: "finished", label: "All 3 emails sent" });
    expect(personState(person({ status: "done", events: [sent(1)] }), NUMBERS, NOW).label).toBe("All 1 email sent");
  });

  it("a soft bounce does not stop anyone by itself", () => {
    expect(personState(person({ events: [sent(1), { type: "soft_bounce", stepPosition: 1, count: 1, at: null }], stepPosition: 2, nextDueAt: "2026-11-20T00:00:00Z" }), NUMBERS, NOW).key).toBe("scheduled");
  });
});

describe("peopleView and peopleSummary", () => {
  const rows = [
    person({ enrollmentId: "e-done", name: "Zed", status: "done", events: [sent(1)] }),
    person({ enrollmentId: "e-wait", name: "Bea", task: { id: "i-2", identifier: "PAR-2", status: "todo" } }),
    person({ enrollmentId: "e-held", name: "Cy", task: { id: "i-1", identifier: "PAR-1", status: "blocked" } }),
    person({ enrollmentId: "e-reply", name: "Al", status: "stopped", events: [sent(1), { type: "reply", stepPosition: 1, count: 1, at: null }] }),
    person({ enrollmentId: "e-gone", name: null, status: "stopped", events: [sent(1), { type: "unsubscribe", stepPosition: 1, count: 1, at: null }] }),
  ];

  it("lists people who need a fix first, then by name", () => {
    expect(peopleView(rows, STEPS, NOW).map((p) => p.enrollmentId)).toEqual(["e-held", "e-wait", "e-reply", "e-gone", "e-done"]);
  });

  it("counts each state once", () => {
    expect(peopleSummary(peopleView(rows, STEPS, NOW))).toEqual({ total: 5, waiting: 1, held: 1, emailed: 3, replied: 1, optedOut: 1, bounced: 0, finished: 1 });
  });
});

describe("resultsView", () => {
  const steps = [
    { position: 1, subject: "Hello", variant: "a" },
    { position: 1, subject: "Hello B", variant: "b" },
    { position: 3, subject: "Follow up", variant: "a" },
  ];
  const rows = [
    { stepPosition: 1, variant: "a", eventType: "sent", count: 20 },
    { stepPosition: 1, variant: "b", eventType: "sent", count: 18 },
    { stepPosition: 1, variant: "a", eventType: "reply", count: 2 },
    { stepPosition: 1, variant: "b", eventType: "reply", count: 5 },
    { stepPosition: 1, variant: null, eventType: "unsubscribe", count: 1 },
    { stepPosition: 3, variant: "a", eventType: "sent", count: 10 },
    { stepPosition: 3, variant: "a", eventType: "bounce", count: 1 },
    { stepPosition: 3, variant: "a", eventType: "skipped", count: 4 },
  ];

  it("adds up totals and splits a step with a B version by version", () => {
    const view = resultsView(steps, rows);
    expect(view.totals).toMatchObject({ sent: 48, replies: 7, unsubscribes: 1, bounces: 1 });
    expect(view.steps.map((s) => [s.number, s.position, s.subject, s.totals.sent])).toEqual([[1, 1, "Hello", 38], [2, 3, "Follow up", 10]]);
    expect(view.steps[0]!.versions).toMatchObject({ a: { sent: 20, replies: 2, unsubscribes: 1 }, b: { sent: 18, replies: 5 } });
    expect(view.steps[1]!.versions).toBeNull();
    expect(view.steps.map((s) => s.subjectB)).toEqual(["Hello B", null]);
  });

  it("an event with no version counts under A, and an unknown kind is ignored", () => {
    const view = resultsView(steps, rows);
    expect(view.steps[0]!.versions!.a.unsubscribes).toBe(1);
    expect(JSON.stringify(view)).not.toContain("skipped");
  });

  it("says whether the provider reported and whether anything is tracked", () => {
    expect(resultsView(steps, rows)).toMatchObject({ providerReports: false, tracked: false });
    expect(resultsView(steps, [...rows, { stepPosition: 1, variant: "a", eventType: "delivered", count: 19 }]).providerReports).toBe(true);
    expect(resultsView(steps, [...rows, { stepPosition: 1, variant: "a", eventType: "click", count: 3 }]).tracked).toBe(true);
  });

  it("events of a step that was removed still show, so the rows add up to the totals", () => {
    const view = resultsView([{ position: 1, subject: "Hello" }], [{ stepPosition: 1, variant: "a", eventType: "sent", count: 2 }, { stepPosition: 9, variant: "a", eventType: "sent", count: 3 }]);
    expect(view.totals.sent).toBe(5);
    expect(view.steps.map((s) => [s.position, s.totals.sent, s.subject])).toEqual([[1, 2, "Hello"], [9, 3, "(a step that was removed)"]]);
  });

  it("no events gives zeros for every step, and rate is null without sends", () => {
    expect(resultsView(steps, []).steps.every((s) => s.totals.sent === 0)).toBe(true);
    expect(resultsView(steps, []).totals).toEqual(emptyCounts());
    expect(rate(1, 0)).toBeNull();
    expect(rate(1, 4)).toBe(0.25);
  });
});

describe("unfilledPlaceholders", () => {
  it("finds leftover markers and unknown merge fields in subject, text and html, and leaves known fields alone", () => {
    expect(unfilledPlaceholders({ subject: "Hi {{first_name|there}}", body: "CODE: NOT-ISSUED-YET", htmlBody: "<p>{{code}}</p>" })).toEqual(["{{code}}", "NOT-ISSUED-YET"]);
    expect(unfilledPlaceholders({ subject: "Hi {{first_name}}", body: "See {{unsubscribe_url}}. Todo list, STUDIO-TBC-1." })).toEqual([]);
  });
});
