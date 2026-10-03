/**
 * Acceptance journeys, the pure part (Q5-1): the file format and its checks, the
 * path language, what counts as a pass, the canary guard and the run's state
 * machine. Each expectation is tested both ways: a test that could not fail
 * would say nothing about a journey.
 */
import { describe, expect, it } from "vitest";
import {
  abortRun,
  AcceptanceError,
  checkExpectation,
  failurePlans,
  getPath,
  guardInput,
  initRun,
  inputRequired,
  isCanaryClientRef,
  isEmptyInput,
  lastMonth,
  nextStep,
  outputText,
  parseJourney,
  recordStep,
  recordIdOf,
  renderValue,
  reportMarkdown,
  runFinished,
  runStatus,
  runSummary,
  settle,
  storedInput,
  type Facts,
  type Journey,
  type RunState,
} from "../src/acceptance-model.js";

const ROLES = ["account-manager", "operator", "social"];
const CANARY = "company:canary-1a2b3c4d";
const NOW = "2026-10-04T02:40:00.000Z";

function journey(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    key: "demo-journey",
    version: 1,
    title: "Demo",
    summary: "A demo journey.",
    schedule: ["nightly"],
    plugins: ["partnersinbiz.crm"],
    ownerRole: "account-manager",
    steps: [
      { id: "ensure", title: "Find the canary", kind: "tool", tool: "partnersinbiz.crm:create-canary-client", input: {}, expect: [{ path: "client", equals: "{{client}}" }], capture: { contactId: { path: "contact.ref", strip: "contact:" } } },
      { id: "note", title: "Log a note", kind: "tool", tool: "partnersinbiz.crm:log-activity", input: { recordType: "contact", recordId: "{{contactId}}", body: "Run {{runId}}" }, expect: [{ path: "id", notEmpty: true }] },
      { id: "clean", title: "Clean up", kind: "tool", tool: "partnersinbiz.crm:cleanup-canary", input: { confirm: true }, expect: [{ path: "cleaned", equals: true }], always: true },
    ],
    ...patch,
  };
}

const parsed = (patch: Record<string, unknown> = {}): Journey => parseJourney(journey(patch), ROLES);

function problemsOf(raw: unknown): string {
  try {
    parseJourney(raw, ROLES);
  } catch (error) {
    expect(error).toBeInstanceOf(AcceptanceError);
    return (error as Error).message;
  }
  return "";
}

describe("parseJourney", () => {
  it("accepts a well-formed journey", () => {
    expect(parsed().steps).toHaveLength(3);
  });

  it("lists every problem in one message", () => {
    const text = problemsOf(journey({ key: "Bad Key", version: 0, schedule: ["sometimes"], plugins: [], ownerRole: "ghost", steps: [] }));
    for (const part of ["key must be", "version must be", "schedule lists", "plugins lists", "ownerRole must be", "1 to 30 steps"]) expect(text, part).toContain(part);
  });

  it("refuses a step that could never fail, or checks nothing", () => {
    const steps = (journey().steps as Array<Record<string, unknown>>).slice();
    steps[1] = { ...steps[1]!, expect: [] };
    expect(problemsOf(journey({ steps }))).toContain("could never fail");
    steps[1] = { ...steps[1]!, expect: [{ path: "id" }] };
    expect(problemsOf(journey({ steps }))).toContain("checks nothing");
    // A check step with a probe may have no expectations: the probe is the check.
    steps[1] = { id: "closed", title: "Closed", kind: "check", expect: [], probe: { kind: "issue", idPath: "issueId" } };
    expect(problemsOf(journey({ steps }))).toBe("");
  });

  it("refuses a name no earlier step captures, in the input, an expectation or a probe", () => {
    const steps = (journey().steps as Array<Record<string, unknown>>).slice();
    steps[0] = { ...steps[0]!, input: { x: "{{contactId}}" } };
    expect(problemsOf(journey({ steps }))).toContain("{{contactId}}");
    const later = (journey().steps as Array<Record<string, unknown>>).slice();
    later[1] = { ...later[1]!, expect: [{ path: "id", equals: "{{ghost}}" }] };
    expect(problemsOf(journey({ steps: later }))).toContain("{{ghost}}");
    later[1] = { ...later[1]!, expect: [{ path: "id", notEmpty: true }], probe: { kind: "issue", idPath: "id", matches: "{{ghost}}" } };
    expect(problemsOf(journey({ steps: later }))).toContain("{{ghost}}");
  });

  it("knows the built-in names and what earlier steps captured", () => {
    expect(problemsOf(journey())).toBe("");
    const steps = (journey().steps as Array<Record<string, unknown>>).slice();
    steps[1] = { ...steps[1]!, expect: [{ path: "n", gtCapture: "never" }] };
    expect(problemsOf(journey({ steps }))).toContain("compares with never");
  });

  it("refuses a duplicate id, a tool on a non-tool step, a tool step with no tool, and an invalid pattern", () => {
    const steps = (journey().steps as Array<Record<string, unknown>>).slice();
    steps[1] = { ...steps[1]!, id: "ensure" };
    expect(problemsOf(journey({ steps }))).toContain("used twice");
    steps[1] = { id: "web", title: "Call", kind: "http", tool: "partnersinbiz.crm:x", expect: [{ path: "status", equals: 200 }] };
    expect(problemsOf(journey({ steps }))).toContain("only a tool step has a tool");
    steps[1] = { id: "web", title: "Call", kind: "tool", expect: [{ path: "status", equals: 200 }] };
    expect(problemsOf(journey({ steps }))).toContain("names its tool");
    steps[1] = { id: "web", title: "Call", kind: "tool", tool: "partnersinbiz.crm:x", expect: [{ path: "status", matches: "(" }] };
    expect(problemsOf(journey({ steps }))).toContain("invalid pattern");
  });

  it("keeps the steps that always run (cleanup) last, and needs screenshot evidence on a ui step", () => {
    const steps = (journey().steps as Array<Record<string, unknown>>).slice();
    expect(problemsOf(journey({ steps: [steps[2], steps[0], steps[1]] }))).toContain("come last");
    steps[1] = { id: "look", title: "Look", kind: "ui", expect: [{ path: "$", notEmpty: true }] };
    expect(problemsOf(journey({ steps }))).toContain("screenshot evidence");
  });
});

describe("getPath", () => {
  const value = { client: "company:x", contact: { email: "a@canary.invalid" }, sources: [{ accepted: 2 }, { accepted: 5 }], deals: [{ id: "d1", status: "open" }, { id: "d2", status: "won" }], zero: 0, no: null };

  it("reads dots, indexes and key=value filters", () => {
    expect(getPath(value, "client")).toEqual({ found: true, value: "company:x" });
    expect(getPath(value, "contact.email").value).toBe("a@canary.invalid");
    expect(getPath(value, "sources[1].accepted").value).toBe(5);
    expect(getPath(value, "deals[id=d2].status").value).toBe("won");
    expect(getPath(value, "$").value).toBe(value);
  });

  it("says not found for a missing step of the path, and finds a zero", () => {
    for (const path of ["nope", "contact.phone", "sources[7].accepted", "deals[id=zzz].status", "client.x"]) expect(getPath(value, path).found, path).toBe(false);
    expect(getPath(value, "zero")).toEqual({ found: true, value: 0 });
  });
});

describe("renderValue", () => {
  it("fills names in text and keeps a whole-name value's type", () => {
    const missing = new Set<string>();
    expect(renderValue({ a: "Run {{runId}}", n: "{{count}}", list: ["{{runId}}"] }, { runId: "r1", count: 7 }, missing)).toEqual({ a: "Run r1", n: 7, list: ["r1"] });
    expect(missing.size).toBe(0);
  });

  it("leaves an unknown name in place and lists it", () => {
    const missing = new Set<string>();
    expect(renderValue({ a: "{{ghost}} and {{runId}}" }, { runId: "r1" }, missing)).toEqual({ a: "{{ghost}} and r1" });
    expect([...missing]).toEqual(["ghost"]);
    // A merge token of another system is not ours.
    expect(renderValue("Hi {{first_name|there}}", {})).toBe("Hi {{first_name|there}}");
  });
});

describe("checkExpectation", () => {
  const out = { client: CANARY, email: "x@canary.invalid", n: 3, list: ["a", "b"], empty: [], status: 200 };
  const ok = (e: Record<string, unknown>, captures: Record<string, unknown> = {}) => checkExpectation(out, { path: "client", ...e } as never, captures).every((c) => c.ok);

  it("passes and fails each operator", () => {
    expect(ok({ equals: CANARY })).toBe(true);
    expect(ok({ equals: "company:other" })).toBe(false);
    expect(checkExpectation(out, { path: "email", endsWith: "@canary.invalid" }).every((c) => c.ok)).toBe(true);
    expect(checkExpectation(out, { path: "email", endsWith: "@gmail.com" }).every((c) => c.ok)).toBe(false);
    expect(checkExpectation(out, { path: "client", matches: "^company:canary-[a-z0-9]{4,}$" }).every((c) => c.ok)).toBe(true);
    expect(checkExpectation(out, { path: "client", matches: "^contact:" }).every((c) => c.ok)).toBe(false);
    expect(checkExpectation(out, { path: "list", contains: "b" }).every((c) => c.ok)).toBe(true);
    expect(checkExpectation(out, { path: "list", contains: "z" }).every((c) => c.ok)).toBe(false);
    expect(checkExpectation(out, { path: "status", oneOf: [200, 201] }).every((c) => c.ok)).toBe(true);
    expect(checkExpectation(out, { path: "status", oneOf: [500] }).every((c) => c.ok)).toBe(false);
    expect(checkExpectation(out, { path: "n", gte: 3 }).every((c) => c.ok)).toBe(true);
    expect(checkExpectation(out, { path: "n", gte: 4 }).every((c) => c.ok)).toBe(false);
    expect(checkExpectation(out, { path: "n", lte: 2 }).every((c) => c.ok)).toBe(false);
    expect(checkExpectation(out, { path: "empty", notEmpty: true }).every((c) => c.ok)).toBe(false);
    expect(checkExpectation(out, { path: "list", notEmpty: true }).every((c) => c.ok)).toBe(true);
  });

  it("compares with a number captured earlier, strictly for gt", () => {
    expect(checkExpectation(out, { path: "n", gtCapture: "before" }, { before: 2 }).every((c) => c.ok)).toBe(true);
    expect(checkExpectation(out, { path: "n", gtCapture: "before" }, { before: 3 }).every((c) => c.ok)).toBe(false);
    expect(checkExpectation(out, { path: "n", gteCapture: "before" }, { before: 3 }).every((c) => c.ok)).toBe(true);
    expect(checkExpectation(out, { path: "n", gtCapture: "before" }, {}).every((c) => c.ok)).toBe(false);
  });

  it("fails a missing path and says so, and honours exists: false", () => {
    const [check] = checkExpectation(out, { path: "ghost", notEmpty: true });
    expect(check!.ok).toBe(false);
    expect(check!.detail).toContain("ghost is missing");
    expect(checkExpectation(out, { path: "ghost", exists: false }).every((c) => c.ok)).toBe(true);
    expect(checkExpectation(out, { path: "client", exists: false }).every((c) => c.ok)).toBe(false);
  });

  it("needs every operator in one expectation to hold", () => {
    expect(checkExpectation(out, { path: "n", gte: 1, lte: 2 }).every((c) => c.ok)).toBe(false);
    expect(checkExpectation(out, { path: "n", gte: 1, lte: 5 }).every((c) => c.ok)).toBe(true);
  });
});

describe("the built-in names", () => {
  it("a run starts with the client, its record id, the run id, today, a date a year out and last month", () => {
    const state = initRun(parsed(), CANARY, "run1", "2026-10-04");
    expect(state.captures).toEqual({ client: CANARY, companyRecordId: "canary-1a2b3c4d", runId: "run1", date: "2026-10-04", futureDate: "2027-11-08", period: "2026-09" });
  });

  it("last month crosses the year", () => {
    expect(lastMonth("2026-01-15")).toBe("2025-12");
    expect(lastMonth("2026-03-31")).toBe("2026-02");
  });
});

describe("the canary guard", () => {
  it("accepts only the canary company ref", () => {
    expect(isCanaryClientRef(CANARY)).toBe(true);
    for (const ref of ["company:6f1c2b0e-1111-4222-8333-444455556666", "contact:canary-1a2b3c4d", "company:canary-", "canary-1a2b3c4d", "company:canary-1a2b3c4d/../x", "", null, undefined]) expect(isCanaryClientRef(ref), String(ref)).toBe(false);
    expect(recordIdOf(CANARY)).toBe("canary-1a2b3c4d");
  });

  it("flags a real address, a real domain and another client, anywhere in the input", () => {
    expect(guardInput({ customerEmail: "canary@canary.invalid", client: CANARY, companyRecordId: "canary-1a2b3c4d", contactId: "canary-contact-1" }, CANARY)).toEqual([]);
    expect(guardInput({ curl: "curl -d '{\"email\":\"jane@example.com\"}'" }, CANARY)[0]).toContain("jane@example.com");
    expect(guardInput({ nested: [{ sendTo: "ceo@acme.co.za" }] }, CANARY)[0]).toContain("ceo@acme.co.za");
    expect(guardInput({ client: "company:6f1c2b0e-1111-4222-8333-444455556666" }, CANARY)[0]).toContain("not the canary client");
    expect(guardInput({ companyRecordId: "6f1c2b0e-1111-4222-8333-444455556666" }, CANARY)[0]).toContain("companyRecordId");
    expect(guardInput({ customerRef: "someone-else" }, CANARY)[0]).toContain("customerRef");
    // Any reserved .invalid name is no-one's mailbox.
    expect(guardInput({ to: "x@mail.canary.invalid" }, CANARY)).toEqual([]);
  });

  it("lets the kind words through and ignores input with no addresses", () => {
    expect(guardInput({ clientKind: "company", recordType: "contact", amountMinor: 100 }, CANARY)).toEqual([]);
    expect(guardInput(undefined, CANARY)).toEqual([]);
  });
});


describe("the input a step must come with (the guard only sees what it is told)", () => {
  const j = parsed();
  const fresh = () => initRun(j, CANARY, "run1", "2026-10-04");
  const none: Facts = {};
  const after = () => recordStep(j, fresh(), "ensure", { output: { client: CANARY, contact: { ref: "contact:canary-contact-1" } }, input: {} }, none, NOW).state;
  const note = { output: { id: "a1", recordId: "canary-contact-1" } };

  it("a tool step the journey gives input to fails when none is reported, and says why; the run is not aborted", () => {
    const missing = recordStep(j, after(), "note", note, none, NOW);
    expect(missing.result.status).toBe("failed");
    expect(missing.aborted).toBe(false);
    expect(missing.result.checks.some((c) => !c.ok && c.detail.includes("No input was reported"))).toBe(true);
    // The output was fine: only the missing input fails it.
    expect(missing.result.checks.filter((c) => !c.ok)).toHaveLength(1);
    // Nothing is captured from it, and what follows is blocked.
    expect(missing.state.steps.map((s) => s.status)).toEqual(["passed", "failed", "pending"]);
  });

  it("an empty input counts as none: {}, '', [] and null all fail, a reported input passes", () => {
    for (const empty of [{}, "", "  ", [], null, undefined]) {
      expect(recordStep(j, after(), "note", { ...note, input: empty }, none, NOW).result.status, JSON.stringify(empty)).toBe("failed");
    }
    const given = recordStep(j, after(), "note", { ...note, input: { recordType: "contact", recordId: "canary-contact-1", body: "Run run1" } }, none, NOW);
    expect(given.result.status).toBe("passed");
  });

  it("a step with no input of its own, a skipped step and a step that reports an error are not asked for it twice", () => {
    // `ensure` has an empty input in the journey: nothing to require.
    expect(recordStep(j, fresh(), "ensure", { output: { client: CANARY, contact: { ref: "contact:canary-contact-1" } } }, none, NOW).result.status).toBe("passed");
    const optional = parsed({ steps: [{ id: "maybe", title: "Maybe", kind: "tool", tool: "partnersinbiz.crm:log-activity", input: { body: "x" }, optional: true, expect: [{ path: "id", notEmpty: true }] }] });
    expect(recordStep(optional, initRun(optional, CANARY, "r", "2026-10-04"), "maybe", { skip: "module is off" }, none, NOW).result.status).toBe("skipped");
    const errored = recordStep(j, after(), "note", { error: "boom" }, none, NOW);
    expect(errored.result.checks.map((c) => c.detail).join(" ")).toContain("reported an error: boom");
  });

  it("only tool and http steps are asked: a ui or check step records without input", () => {
    for (const kind of ["ui", "check"] as const) expect(inputRequired({ kind, input: { url: "x" } }), kind).toBe(false);
    for (const kind of ["tool", "http"] as const) {
      expect(inputRequired({ kind, input: { a: 1 } }), kind).toBe(true);
      expect(inputRequired({ kind, input: {} }), `${kind} with an empty input`).toBe(false);
      expect(inputRequired({ kind }), `${kind} with none`).toBe(false);
    }
  });

  it("when the input is not the canary's the run aborts on that, not on the missing-input rule", () => {
    const bad = recordStep(j, after(), "note", { ...note, input: { recordId: "x", to: "jane@example.com" } }, none, NOW);
    expect(bad.aborted).toBe(true);
    expect(bad.result.checks.some((c) => c.detail.includes("No input was reported"))).toBe(false);
  });

  it("isEmptyInput", () => {
    for (const empty of [undefined, null, "", "   ", [], {}]) expect(isEmptyInput(empty), JSON.stringify(empty)).toBe(true);
    for (const given of ["x", [1], { a: 1 }, 0, false]) expect(isEmptyInput(given), JSON.stringify(given)).toBe(false);
  });
});

describe("what a run keeps of the input it was given", () => {
  it("blanks anything under a secret-looking name and anything that looks like a credential, at any depth", () => {
    const kept = storedInput({ body: "hello", apiKey: "abc123", nested: { password: "hunter2", list: [{ token: 7 }, "Bearer abcdefghijklmnop"] }, link: "https://user:pw@host.example/x" }) as Record<string, any>;
    expect(kept.body).toBe("hello");
    expect(kept.apiKey).toBe("[redacted]");
    expect(kept.nested.password).toBe("[redacted]");
    expect(kept.nested.list[0].token).toBe("[redacted]");
    expect(kept.nested.list[1]).toBe("Bearer [redacted]");
    expect(kept.link).toBe("https://[redacted]@host.example/x");
    expect(JSON.stringify(kept)).not.toMatch(/hunter2|abc123|abcdefghijklmnop|user:pw/);
  });

  it("cuts a long input and keeps a short one as it is", () => {
    const short = { recordId: "canary-1", body: "x" };
    expect(storedInput(short)).toEqual(short);
    const long = storedInput({ body: "y".repeat(5000) });
    expect(typeof long).toBe("string");
    expect((long as string).length).toBeLessThanOrEqual(1500);
    expect(storedInput(undefined)).toBeUndefined();
  });

  it("the stored result holds the redacted input, never the raw one", () => {
    const j = parsed();
    const state = recordStep(j, initRun(j, CANARY, "run1", "2026-10-04"), "ensure", { output: { client: CANARY, contact: { ref: "contact:canary-contact-1" } }, input: { apiKey: "sk-live-abcdefghijklmnopqrstuvwx" } }, {}, NOW).state;
    expect(JSON.stringify(state.steps[0]!.input)).not.toContain("abcdefghijklmnop");
    expect((state.steps[0]!.input as Record<string, string>).apiKey).toBe("[redacted]");
  });
});

describe("a run", () => {
  const j = parsed();
  const fresh = () => initRun(j, CANARY, "run1", "2026-10-04");
  const none: Facts = {};
  const good = {
    ensure: { output: { client: CANARY, contact: { ref: "contact:canary-contact-1" } }, input: {} },
    note: { output: { id: "a1", recordId: "canary-contact-1" }, input: { recordType: "contact", recordId: "canary-contact-1", body: "Run run1" } },
    clean: { output: { cleaned: true }, input: { confirm: true } },
  };

  it("refuses to start for anything but the canary client", () => {
    for (const ref of ["company:6f1c2b0e-1111-4222-8333-444455556666", "contact:canary-1", ""]) expect(() => initRun(j, ref, "r", "2026-10-04"), ref).toThrow(/only on the canary client/);
  });

  it("hands out the steps in order with the captures filled in, and passes when every step does", () => {
    let state = fresh();
    expect(nextStep(j, state)!.step.id).toBe("ensure");
    state = recordStep(j, state, "ensure", good.ensure, none, NOW).state;
    const second = nextStep(j, state)!;
    expect(second.step.id).toBe("note");
    expect(second.input).toEqual({ recordType: "contact", recordId: "canary-contact-1", body: "Run run1" });
    expect(second.index).toBe(2);
    state = recordStep(j, state, "note", good.note, none, NOW).state;
    expect(runFinished(j, state)).toBe(false);
    state = recordStep(j, state, "clean", good.clean, none, NOW).state;
    expect(runStatus(j, state)).toBe("passed");
    expect(runFinished(j, state)).toBe(true);
    expect(nextStep(j, state)).toBeNull();
  });

  it("takes the steps in order", () => {
    expect(() => recordStep(j, fresh(), "note", good.note, none, NOW)).toThrow(/next step is ensure/);
    const state = recordStep(j, fresh(), "ensure", good.ensure, none, NOW).state;
    expect(() => recordStep(j, state, "ensure", good.ensure, none, NOW)).toThrow(/already recorded/);
    expect(() => recordStep(j, state, "ghost", good.ensure, none, NOW)).toThrow(/no step ghost/);
  });

  it("fails a step whose result misses an expectation, blocks the rest and still runs the cleanup", () => {
    let state = recordStep(j, fresh(), "ensure", good.ensure, none, NOW).state;
    const failed = recordStep(j, state, "note", { output: { nothing: true }, input: {} }, none, NOW);
    expect(failed.result.status).toBe("failed");
    expect(failed.result.checks.some((c) => !c.ok && c.detail.includes("id is missing"))).toBe(true);
    state = failed.state;
    // The cleanup is next, even after a failure.
    expect(nextStep(j, state)!.step.id).toBe("clean");
    state = recordStep(j, state, "clean", good.clean, none, NOW).state;
    expect(runStatus(j, state)).toBe("failed");
    expect(runSummary(j, state)).toBe("Failed at Log a note.");
  });

  it("blocks later steps (not cleanup) after a failure", () => {
    const state = recordStep(j, fresh(), "ensure", { output: { client: "company:other", contact: { ref: "contact:x" } }, input: {} }, none, NOW).state;
    expect(state.steps.map((s) => s.status)).toEqual(["failed", "blocked", "pending"]);
    expect(state.steps[1]!.note).toBe("Not run: an earlier step failed.");
  });

  it("fails a step that reports an error, whatever else it says", () => {
    const { result } = recordStep(j, fresh(), "ensure", { error: "boom", output: good.ensure.output, input: {} }, none, NOW);
    expect(result.status).toBe("failed");
    expect(result.checks[0]!.detail).toContain("reported an error: boom");
  });

  it("captures only from a step that passed", () => {
    const bad = recordStep(j, fresh(), "ensure", { output: { client: "company:other", contact: { ref: "contact:canary-contact-1" } }, input: {} }, none, NOW);
    expect(bad.state.captures.contactId).toBeUndefined();
    const ok = recordStep(j, fresh(), "ensure", good.ensure, none, NOW);
    expect(ok.state.captures.contactId).toBe("canary-contact-1");
  });

  it("fails a step whose capture path is missing, so a later step never runs on nothing", () => {
    const { result } = recordStep(j, fresh(), "ensure", { output: { client: CANARY, contact: {} }, input: {} }, none, NOW);
    expect(result.status).toBe("failed");
    expect(result.checks.some((c) => c.detail.includes("needed later as contactId"))).toBe(true);
  });

  it("aborts the run when the reported input is not the canary, and runs nothing else", () => {
    const state = recordStep(j, fresh(), "ensure", good.ensure, none, NOW).state;
    const touched = recordStep(j, state, "note", { output: { id: "a1", recordId: "x" }, input: { recordType: "contact", recordId: "6f1c2b0e-1111-4222-8333-444455556666", body: "mail jane@example.com" } }, none, NOW);
    expect(touched.aborted).toBe(true);
    expect(touched.result.status).toBe("failed");
    expect(touched.result.checks.filter((c) => !c.ok).length).toBeGreaterThanOrEqual(2);
    expect(runStatus(j, touched.state)).toBe("aborted");
    expect(nextStep(j, touched.state)).toBeNull();
    expect(touched.state.steps[2]!.status).toBe("blocked");
    expect(touched.state.abortReason).toContain("not the canary");
  });

  it("lets only an optional or planned step be skipped", () => {
    const withOptional = parsed({ steps: (journey().steps as Array<Record<string, unknown>>).map((s) => (s.id === "note" ? { ...s, optional: true } : s)) });
    let state = recordStep(withOptional, initRun(withOptional, CANARY, "r", "2026-10-04"), "ensure", good.ensure, none, NOW).state;
    const skipped = recordStep(withOptional, state, "note", { skip: "mailbox module is off" }, none, NOW);
    expect(skipped.result.status).toBe("skipped");
    const refused = recordStep(j, recordStep(j, fresh(), "ensure", good.ensure, none, NOW).state, "note", { skip: "not needed" }, none, NOW);
    expect(refused.result.status).toBe("failed");
    expect(refused.result.checks[0]!.detail).toContain("may not be skipped");
  });

  it("skips a planned step by itself and never hands it out", () => {
    const planned = parsed({ steps: (journey().steps as Array<Record<string, unknown>>).map((s) => (s.id === "note" ? { ...s, planned: true } : s)) });
    let state = initRun(planned, CANARY, "r", "2026-10-04");
    state = recordStep(planned, state, "ensure", good.ensure, none, NOW).state;
    expect(nextStep(planned, state)!.step.id).toBe("clean");
    state = recordStep(planned, state, "clean", good.clean, none, NOW).state;
    expect(runStatus(planned, state)).toBe("passed");
    expect(state.steps[1]!.status).toBe("skipped");
    expect(state.steps[1]!.note).toContain("not shipped yet");
  });

  it("an aborted run is never a pass", () => {
    const state = abortRun(j, recordStep(j, fresh(), "ensure", good.ensure, none, NOW).state, "the mailbox module is switched off");
    expect(runStatus(j, state)).toBe("aborted");
    expect(runSummary(j, state)).toContain("Aborted: the mailbox module is switched off");
    expect(state.steps.every((s) => s.status !== "pending")).toBe(true);
  });

  it("checks an issue probe against what the Cockpit looked up", () => {
    const withProbe = parsed({
      steps: [
        ...(journey().steps as Array<Record<string, unknown>>).slice(0, 1),
        { id: "close", title: "Close it", kind: "check", expect: [{ path: "issueId", notEmpty: true }], probe: { kind: "issue", idPath: "issueId", status: ["done"], matches: "canary|{{runId}}" } },
        ...(journey().steps as Array<Record<string, unknown>>).slice(2),
      ],
    });
    const base = recordStep(withProbe, initRun(withProbe, CANARY, "run9", "2026-10-04"), "ensure", good.ensure, none, NOW).state;
    const issue = { id: "i1", status: "done", title: "Lead from Acceptance run run9", description: "", assigneeAgentId: null, assigneeUserId: null };
    expect(recordStep(withProbe, base, "close", { output: { issueId: "i1" }, input: {} }, { issue }, NOW).result.status).toBe("passed");
    // The agent only says it closed it: the issue is still open, or is not there, or is not the canary's.
    expect(recordStep(withProbe, base, "close", { output: { issueId: "i1" }, input: {} }, { issue: { ...issue, status: "todo" } }, NOW).result.status).toBe("failed");
    expect(recordStep(withProbe, base, "close", { output: { issueId: "i1" }, input: {} }, { issue: null }, NOW).result.status).toBe("failed");
    expect(recordStep(withProbe, base, "close", { output: { issueId: "i1" }, input: {} }, { issue: { ...issue, title: "A real client's lead", description: "x" } }, NOW).result.status).toBe("failed");
  });

  it("fails an approval that reached nobody, and outward work that skipped the Reviewer", () => {
    const withGate = parsed({
      steps: [
        ...(journey().steps as Array<Record<string, unknown>>).slice(0, 1),
        { id: "gate", title: "Ask to send", kind: "tool", tool: "partnersinbiz.billing:request-invoice-send", input: {}, expect: [{ path: "issueId", notEmpty: true }], probe: { kind: "approval-route", idPath: "issueId", outward: true } },
        ...(journey().steps as Array<Record<string, unknown>>).slice(2),
      ],
    });
    const base = recordStep(withGate, initRun(withGate, CANARY, "r", "2026-10-04"), "ensure", good.ensure, none, NOW).state;
    const call = (facts: Facts) => recordStep(withGate, base, "gate", { output: { issueId: "i2" }, input: {} }, facts, NOW).result;
    expect(call({ assignedTo: "reviewer", reviewOutward: true }).status).toBe("passed");
    const nobody = call({ assignedTo: "nobody", reviewOutward: true });
    expect(nobody.status).toBe("failed");
    expect(nobody.checks.some((c) => c.detail.includes("nobody assigned"))).toBe(true);
    const skippedReviewer = call({ assignedTo: "person", reviewOutward: true });
    expect(skippedReviewer.status).toBe("failed");
    expect(skippedReviewer.checks.some((c) => c.detail.includes("not the Reviewer first"))).toBe(true);
    // The company does not use the Reviewer: a person is fine.
    expect(call({ assignedTo: "person", reviewOutward: false }).status).toBe("passed");
  });

  it("needs the evidence a step lists", () => {
    const withEvidence = parsed({
      steps: (journey().steps as Array<Record<string, unknown>>).map((s) => (s.id === "ensure" ? { ...s, evidence: ["curl", "screenshot"] } : s)),
    });
    const start = initRun(withEvidence, CANARY, "r", "2026-10-04");
    expect(recordStep(withEvidence, start, "ensure", good.ensure, none, NOW).result.status).toBe("failed");
    const evidence = [{ kind: "curl" as const, ref: "curl ..." }, { kind: "screenshot" as const, ref: "/tmp/shot.png", bytes: 5000 }];
    expect(recordStep(withEvidence, start, "ensure", { ...good.ensure, evidence }, none, NOW).result.status).toBe("passed");
    // A screenshot the worker could not find on disk is no evidence.
    const missing = recordStep(withEvidence, start, "ensure", { ...good.ensure, evidence }, { missingFiles: ["/tmp/shot.png"] }, NOW).result;
    expect(missing.status).toBe("failed");
    expect(missing.checks.some((c) => c.detail.includes("/tmp/shot.png was not found"))).toBe(true);
  });

  it("keeps a secret out of what the report remembers", () => {
    const text = outputText({ note: "token=abcdef1234567890abcdef", key: "ghp_abcdefghijklmnopqrstuvwxyz0123456789" });
    expect(text).not.toContain("abcdef1234567890");
    expect(text).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz");
    expect(outputText("x".repeat(2000)).length).toBeLessThanOrEqual(600);
  });

  describe("the report and the failure plans", () => {
    function finishedWithFailure(): RunState {
      let state = recordStep(j, fresh(), "ensure", good.ensure, none, NOW).state;
      state = recordStep(j, state, "note", { output: {}, input: {}, evidence: [{ kind: "note", ref: "n", note: "looked at it" }] }, none, NOW).state;
      return recordStep(j, state, "clean", good.clean, none, NOW).state;
    }

    it("says what failed, who owns it and what was not run", () => {
      const state = finishedWithFailure();
      const md = reportMarkdown(j, state, { runId: "run1", trigger: "nightly", triggerRef: "nightly:2026-10-04", startedAt: NOW, finishedAt: NOW, children: { note: "/PAR/issues/PAR-9" } });
      expect(md).toContain("FAILED");
      expect(md).toContain("2 of 3 steps passed, 1 failed");
      expect(md).toContain("| 2 | Log a note | FAIL |");
      expect(md).toContain("**Log a note** (owner: account-manager): /PAR/issues/PAR-9");
      expect(md).toContain("Only the canary was touched");
      expect(md).toContain(CANARY);
    });

    it("opens one failure issue per failed step for the owning role, with the evidence and the way back", () => {
      const state = finishedWithFailure();
      const plans = failurePlans(j, state, { runId: "run1", reportLink: "/PAR/issues/PAR-8" });
      expect(plans).toHaveLength(1);
      expect(plans[0]!.ownerRole).toBe("account-manager");
      expect(plans[0]!.title).toBe("Acceptance failure: Demo, Log a note");
      expect(plans[0]!.description).toContain("/PAR/issues/PAR-8");
      expect(plans[0]!.description).toContain("id is missing from the result");
      expect(plans[0]!.description).toContain("the canary: nothing real was touched");
    });

    it("says nothing failed for a pass", () => {
      let state = recordStep(j, fresh(), "ensure", good.ensure, none, NOW).state;
      state = recordStep(j, state, "note", good.note, none, NOW).state;
      state = recordStep(j, state, "clean", good.clean, none, NOW).state;
      expect(failurePlans(j, state, { runId: "r", reportLink: "x" })).toEqual([]);
      expect(reportMarkdown(j, state, { runId: "r", trigger: "release", triggerRef: "partnersinbiz.crm 0.12.0", startedAt: NOW, finishedAt: NOW })).toContain("PASSED");
    });

    it("an unfinished run is in progress, not a pass", () => {
      const state = recordStep(j, fresh(), "ensure", good.ensure, none, NOW).state;
      expect(runStatus(j, state)).toBe("running");
      expect(settle(j, state).steps[1]!.status).toBe("pending");
    });
  });
});
